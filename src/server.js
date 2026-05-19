import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { buildDiscordMessage, postToDiscord } from "./discord.js";
import { dataFiles, ensureDir, readJson, writeJson } from "./storage.js";
import {
  calculateLocalXp,
  canJoinFleet,
  defaultFleets,
  getBottomThreeFleetNames,
  updateGlobalSeen,
} from "./scoring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || "./data");
const API_KEY = process.env.CAPTAINS_LOG_API_KEY || "change_me_station_upload_key";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const POST_TO_DISCORD =
  String(process.env.POST_TO_DISCORD || "true").toLowerCase() === "true";

const INSTALL_COMMAND =
  "curl -sSL https://captains-log-backend-production.up.railway.app/install.sh | bash";

const files = dataFiles(DATA_DIR);
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

function requireApiKey(req, res, next) {
  const headerKey = req.header("x-captains-log-key") || req.header("x-api-key");
  const bodyKey = req.body?.apiKey;
  const key = headerKey || bodyKey;

  if (!key || key !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Invalid or missing Captain's Log API key",
    });
  }

  next();
}

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function reportKey(report) {
  return `${report.stationId || report.station}|${report.date}`;
}

function formatXp(value) {
  return Number(value || 0).toLocaleString("en-GB");
}

function medal(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `${index + 1}.`;
}

function safeShipName(ship) {
  return ship?.name || `MMSI ${ship?.mmsi || ship?.decodedMmsi || "unknown"}`;
}

function shipTypeLabel(ship) {
  return ship?.shipTypeLabel || `Type ${ship?.shipType || "?"}`;
}

function allShipsFromReports(reports) {
  return reports.flatMap((r) =>
    (r.report?.ships || []).map((ship) => ({
      ...ship,
      station: r.station,
      stationId: r.stationId,
      fleet: r.fleet,
      date: r.date,
      uploadedAt: r.uploadedAt,
      xp: r.xp,
    }))
  );
}

function largestShipFromReports(reports) {
  return (
    allShipsFromReports(reports)
      .filter((s) => Number(s.lengthM || 0) > 0)
      .sort((a, b) => Number(b.lengthM || 0) - Number(a.lengthM || 0))[0] ||
    null
  );
}

function rareSpecialShipFromReports(reports) {
  const ships = allShipsFromReports(reports).filter(
    (s) => Number(s.shipType || 0) > 0
  );

  const specialTypes = new Set([
    30, 31, 32, 33, 34, 35, 36, 37,
    50, 51, 52, 53, 54, 55, 58,
  ]);

  const typeCounts = new Map();

  for (const ship of ships) {
    const type = Number(ship.shipType || 0);
    typeCounts.set(type, Number(typeCounts.get(type) || 0) + 1);
  }

  const specialShips = ships.filter((ship) =>
    specialTypes.has(Number(ship.shipType || 0))
  );

  if (specialShips.length) {
    return [...specialShips].sort((a, b) => {
      const aCount = Number(typeCounts.get(Number(a.shipType || 0)) || 0);
      const bCount = Number(typeCounts.get(Number(b.shipType || 0)) || 0);

      if (aCount !== bCount) return aCount - bCount;

      return Number(b.lengthM || 0) - Number(a.lengthM || 0);
    })[0];
  }

  return (
    ships.sort((a, b) => {
      const aCount = Number(typeCounts.get(Number(a.shipType || 0)) || 0);
      const bCount = Number(typeCounts.get(Number(b.shipType || 0)) || 0);

      if (aCount !== bCount) return aCount - bCount;

      return Number(b.lengthM || 0) - Number(a.lengthM || 0);
    })[0] || null
  );
}

function rebuildFleetTotals(fleets, reports) {
  const nextFleets = fleets.map((fleet) => ({
    ...fleet,
    allTimeXp: 0,
    dailyXp: {},
  }));

  for (const report of reports) {
    if (!report.fleet) continue;

    const fleet = nextFleets.find((f) => f.name === report.fleet);
    if (!fleet) continue;

    const xp = Number(report.xp || 0);

    fleet.allTimeXp = Number(fleet.allTimeXp || 0) + xp;
    fleet.dailyXp ||= {};
    fleet.dailyXp[report.date] = Number(fleet.dailyXp[report.date] || 0) + xp;
  }

  return nextFleets;
}

function rebuildStationTotals(stations, reports) {
  return stations.map((station) => {
    const allTimeXp = reports
      .filter((r) => r.stationId === station.stationId)
      .reduce((sum, r) => sum + Number(r.xp || 0), 0);

    return {
      ...station,
      allTimeXp,
    };
  });
}

async function loadState() {
  await ensureDir(DATA_DIR);

  const fleets = await readJson(files.fleets, defaultFleets());
  const stations = await readJson(files.stations, []);
  const reports = await readJson(files.reports, []);
  const globals = await readJson(files.globals, {
    shipNames: [],
    destinations: [],
    mmsis: [],
  });

  return { fleets, stations, reports, globals };
}

function getInstallerFleetOptions(fleets) {
  const fleetRows = Array.isArray(fleets) ? fleets : defaultFleets();

  const bootstrapOpenFleets = fleetRows
    .filter((fleet) => Number(fleet.stationCount || 0) < 5)
    .map((fleet) => fleet.name);

  if (bootstrapOpenFleets.length > 0) {
    return {
      mode: "open",
      reason: "bootstrap_phase",
      fleets: fleetRows.map((fleet) => fleet.name),
      bootstrapOpenFleets,
    };
  }

  return {
    mode: "restricted",
    reason: "bottom_3_rule",
    fleets: getBottomThreeFleetNames(fleetRows),
    bootstrapOpenFleets: [],
  };
}

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "captains-log-backend",
    time: new Date().toISOString(),
  });
});

app.get("/fleets", async (_req, res) => {
  const { fleets } = await loadState();

  res.json({
    ok: true,
    bottomThree: getBottomThreeFleetNames(fleets),
    fleets,
  });
});

app.get("/installer/fleet-options", async (_req, res) => {
  const { fleets } = await loadState();
  const options = getInstallerFleetOptions(fleets);

  res.json({
    ok: true,
    ...options,
    bottomThree: getBottomThreeFleetNames(fleets),
  });
});

app.post("/stations/register", requireApiKey, async (req, res) => {
  const { stationId, stationName, captainDiscordId, fleet } = req.body || {};

  if (
    !requiredString(stationId) ||
    !requiredString(stationName) ||
    !requiredString(fleet)
  ) {
    return res.status(400).json({
      ok: false,
      error: "stationId, stationName and fleet are required",
    });
  }

  const state = await loadState();
  const existing = state.stations.find((s) => s.stationId === stationId);

  if (!existing) {
    const joinCheck = canJoinFleet(state.fleets, fleet);

    if (!joinCheck.ok) {
      return res.status(400).json({
        ok: false,
        error: joinCheck.reason,
        bottomThree: getBottomThreeFleetNames(state.fleets),
      });
    }

    state.stations.push({
      stationId,
      stationName,
      captainDiscordId: captainDiscordId || "",
      fleet,
      createdAt: new Date().toISOString(),
      allTimeXp: 0,
    });

    const fleetRow = state.fleets.find((f) => f.name === fleet);

    if (fleetRow) {
      fleetRow.stationCount = Number(fleetRow.stationCount || 0) + 1;
    }
  } else {
    existing.stationName = stationName;
    existing.captainDiscordId =
      captainDiscordId || existing.captainDiscordId || "";
  }

  await writeJson(files.stations, state.stations);
  await writeJson(files.fleets, state.fleets);

  res.json({
    ok: true,
    station: state.stations.find((s) => s.stationId === stationId),
    bottomThree: getBottomThreeFleetNames(state.fleets),
  });
});

app.post("/reports/upload", requireApiKey, async (req, res) => {
  const body = req.body || {};
  const report = body.report || body;

  if (
    !requiredString(report.station) ||
    !requiredString(report.date) ||
    !requiredString(report.source)
  ) {
    return res.status(400).json({
      ok: false,
      error: "report.station, report.date and report.source are required",
    });
  }

  if (!Array.isArray(report.ships)) {
    return res.status(400).json({
      ok: false,
      error: "report.ships must be an array",
    });
  }

  report.stationId ||= body.stationId || report.station;
  report.captainDiscordId ||= body.captainDiscordId || "";
  report.fleet ||= body.fleet || "";

  const state = await loadState();
  const key = reportKey(report);
  const duplicateIndex = state.reports.findIndex((r) => r.key === key);
  const duplicate = duplicateIndex >= 0 ? state.reports[duplicateIndex] : null;

  if (report.fleet && !state.fleets.find((f) => f.name === report.fleet)) {
    return res.status(400).json({
      ok: false,
      error: "Unknown fleet",
    });
  }

  const scoring = calculateLocalXp(report, state.globals);

  const storedReport = {
    key,
    uploadedAt: new Date().toISOString(),
    stationId: report.stationId,
    station: report.station,
    captainDiscordId: report.captainDiscordId || "",
    fleet: report.fleet || "",
    date: report.date,
    source: report.source,
    xp: scoring.xp,
    scoring: scoring.breakdown,
    report,
  };

  let duplicateAction = "created";

  if (duplicate) {
    const oldXp = Number(duplicate.xp || 0);
    const newXp = Number(scoring.xp || 0);
    const oldShipCount = Number(
      duplicate.report?.uniqueType5Ships || duplicate.report?.ships?.length || 0
    );
    const newShipCount = Number(
      report.uniqueType5Ships || report.ships?.length || 0
    );

    const shouldReplace =
      oldXp <= 0 ||
      newXp > oldXp ||
      (newXp === oldXp && newShipCount > oldShipCount);

    if (!shouldReplace) {
      return res.status(409).json({
        ok: false,
        error:
          "Duplicate report for this station/date. Existing report has equal or better XP.",
        existing: duplicate,
        existingXp: oldXp,
        attemptedXp: newXp,
      });
    }

    storedReport.replaces = {
      uploadedAt: duplicate.uploadedAt,
      xp: oldXp,
      uniqueShips: oldShipCount,
    };

    state.reports[duplicateIndex] = storedReport;
    duplicateAction = "replaced";
  } else {
    state.reports.push(storedReport);
  }

  state.globals = updateGlobalSeen(state.globals, report);
  state.fleets = rebuildFleetTotals(state.fleets, state.reports);
  state.stations = rebuildStationTotals(state.stations, state.reports);

  await writeJson(files.reports, state.reports);
  await writeJson(files.globals, state.globals);
  await writeJson(files.fleets, state.fleets);
  await writeJson(files.stations, state.stations);

  let discord = { skipped: true };

  if (POST_TO_DISCORD) {
    const message = buildDiscordMessage({
      report,
      xp: scoring.xp,
      breakdown: scoring.breakdown,
    });

    discord = await postToDiscord(DISCORD_WEBHOOK_URL, message);
  }

  res.json({
    ok: true,
    action: duplicateAction,
    xp: scoring.xp,
    scoring: scoring.breakdown,
    newShips: scoring.newShips,
    newDestinations: scoring.newDestinations,
    discord,
  });
});

app.get("/reports", async (req, res) => {
  const { reports } = await loadState();
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const rows = [...reports]
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
    .slice(0, limit)
    .map((r) => ({
      uploadedAt: r.uploadedAt,
      date: r.date,
      station: r.station,
      stationId: r.stationId,
      fleet: r.fleet,
      xp: r.xp,
      scoring: r.scoring,
      uniqueShips: r.report?.uniqueType5Ships || r.report?.ships?.length || 0,
      source: r.source,
    }));

  res.json({
    ok: true,
    count: rows.length,
    reports: rows,
  });
});

app.get("/leaderboard", async (_req, res) => {
  const { fleets, stations, reports } = await loadState();
  const today = new Date().toISOString().slice(0, 10);

  const dailyStations = reports
    .filter((r) => r.date === today)
    .map((r) => ({
      station: r.station,
      stationId: r.stationId,
      fleet: r.fleet,
      xp: r.xp,
    }))
    .sort((a, b) => Number(b.xp || 0) - Number(a.xp || 0));

  const dailyFleets = fleets
    .map((f) => ({
      name: f.name,
      xp: Number(f.dailyXp?.[today] || 0),
      allTimeXp: Number(f.allTimeXp || 0),
    }))
    .sort((a, b) => Number(b.xp || 0) - Number(a.xp || 0));

  res.json({
    ok: true,
    today,
    fleets: [...fleets].sort(
      (a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)
    ),
    stations: [...stations].sort(
      (a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)
    ),
    daily: {
      fleets: dailyFleets,
      stations: dailyStations,
    },
    bottomThree: getBottomThreeFleetNames(fleets),
  });
});

app.get("/install.sh", (_req, res) => {
  const installPath = path.join(process.cwd(), "install.sh");

  if (!fs.existsSync(installPath)) {
    return res.status(404).send("install.sh not found");
  }

  res.setHeader("Content-Type", "text/plain");
  fs.createReadStream(installPath).pipe(res);
});

app.get("/captains_log.py", (_req, res) => {
  const scriptPath = path.join(process.cwd(), "captains_log.py");

  if (!fs.existsSync(scriptPath)) {
    return res.status(404).send("captains_log.py not found");
  }

  res.setHeader("Content-Type", "text/plain");
  fs.createReadStream(scriptPath).pipe(res);
});

app.get("/records", async (_req, res) => {
  const { reports } = await loadState();

  const ships = allShipsFromReports(reports);

  const withNumber = (field) =>
    ships.filter((s) => Number.isFinite(Number(s[field])) && Number(s[field]) > 0);

  const maxBy = (field) =>
    withNumber(field).sort((a, b) => Number(b[field]) - Number(a[field]))[0] ||
    null;

  const minBy = (field) =>
    withNumber(field).sort((a, b) => Number(a[field]) - Number(b[field]))[0] ||
    null;

  res.json({
    ok: true,
    totalReports: reports.length,
    totalShips: ships.length,
    records: {
      biggestShip: maxBy("lengthM"),
      smallestShip: minBy("lengthM"),
      deepestDraught: maxBy("draughtM"),
      shallowestDraught: minBy("draughtM"),
      strongestSignal: maxBy("signalpower"),
      weakestSignal: minBy("signalpower"),
    },
  });
});

app.get("/leaderboard/daily/:date", async (req, res) => {
  const { reports, fleets } = await loadState();
  const date = req.params.date;

  const stationRows = reports
    .filter((r) => r.date === date)
    .map((r) => ({
      station: r.station,
      stationId: r.stationId,
      fleet: r.fleet,
      xp: r.xp,
    }))
    .sort((a, b) => b.xp - a.xp);

  const fleetRows = fleets
    .map((f) => ({
      name: f.name,
      xp: Number(f.dailyXp?.[date] || 0),
      allTimeXp: Number(f.allTimeXp || 0),
    }))
    .sort((a, b) => b.xp - a.xp);

  res.json({
    ok: true,
    date,
    stations: stationRows,
    fleets: fleetRows,
  });
});

app.get("/leaderboard/all-time", async (_req, res) => {
  const { fleets, stations } = await loadState();

  res.json({
    ok: true,
    fleets: [...fleets].sort(
      (a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)
    ),
    stations: [...stations].sort(
      (a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)
    ),
    bottomThree: getBottomThreeFleetNames(fleets),
  });
});

function buildFleetScoreboardMessage({ fleets, reports }) {
  const today = new Date().toISOString().slice(0, 10);
  const todaysReports = reports.filter((r) => r.date === today);

  const fleetRows = [...fleets]
    .map((f) => ({
      name: f.name,
      xp: Number(f.dailyXp?.[today] || 0),
      allTimeXp: Number(f.allTimeXp || 0),
    }))
    .sort((a, b) => b.xp - a.xp || b.allTimeXp - a.allTimeXp);

  const allTimeFleetRows = [...fleets]
    .map((f) => ({
      name: f.name,
      allTimeXp: Number(f.allTimeXp || 0),
    }))
    .sort((a, b) => b.allTimeXp - a.allTimeXp);

  const stationRows = [...todaysReports]
    .map((r) => ({
      station: r.station,
      fleet: r.fleet || "No Fleet",
      xp: Number(r.xp || 0),
      uniqueShips: Number(r.report?.uniqueType5Ships || r.report?.ships?.length || 0),
    }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 3);

  const topStation = stationRows[0] || null;
  const largest = largestShipFromReports(todaysReports);
  const rare = rareSpecialShipFromReports(todaysReports);
  const bottomThree = getBottomThreeFleetNames(fleets);
  const totalXpToday = fleetRows.reduce((sum, f) => sum + Number(f.xp || 0), 0);
  const totalStationsToday = todaysReports.length;

  const lines = [
    "🏴‍☠️ **Captain’s Log — Live Fleet Wars**",
    `📅 **${today}** • updates every 2 hours`,
    "",
    `⚔️ **Today’s battle:** ${formatXp(totalXpToday)} XP logged by ${totalStationsToday} station${totalStationsToday === 1 ? "" : "s"}`,
    "",
    "🏆 **Live fleet standings today:**",
    ...fleetRows.map((f, i) => {
      const crown = i === 0 && f.xp > 0 ? " 👑" : "";
      return `${medal(i)} **${f.name}** — ${formatXp(f.xp)} XP${crown}`;
    }),
    "",
    "📜 **All-time fleet XP:**",
    allTimeFleetRows
      .map((f, i) => `${i + 1}. ${f.name} — ${formatXp(f.allTimeXp)} XP`)
      .join(" • "),
    "",
  ];

  if (topStation) {
    lines.push(
      `⭐ **Top station today:** ${topStation.station} — ${formatXp(topStation.xp)} XP (${topStation.fleet})`,
      "",
      "🎖 **Top 3 stations today:**",
      ...stationRows.map(
        (s, i) =>
          `${medal(i)} **${s.station}** — ${formatXp(s.xp)} XP • ${s.uniqueShips} ships • ${s.fleet}`
      ),
      ""
    );
  } else {
    lines.push("🎖 **Top stations today:** No station logs yet.", "");
  }

  if (largest) {
    const length = largest.lengthM ? `${largest.lengthM}m` : "unknown length";
    lines.push(
      `👑 **Largest vessel today:** ${safeShipName(largest)} — ${length} • ${shipTypeLabel(largest)} • ${largest.station}`
    );
  } else {
    lines.push("👑 **Largest vessel today:** Waiting for a confirmed vessel length.");
  }

  if (rare) {
    lines.push(
      `☢️ **Rare/special vessel today:** ${safeShipName(rare)} — ${shipTypeLabel(rare)} • ${rare.station}`
    );
  } else {
    lines.push("☢️ **Rare/special vessel today:** None spotted yet.");
  }

  lines.push(
    "",
    "🟢 **Fleets open for new stations:**",
    ...bottomThree.map((name) => `• ${name}`),
    "",
    "🚀 **Join Captain’s Log**",
    "Run this on your MastChain Raspberry Pi:",
    "```bash",
    INSTALL_COMMAND,
    "```"
  );

  return {
    content: lines.join("\n"),
  };
}

app.post("/admin/post-fleet-scoreboard", requireApiKey, async (_req, res) => {
  const { fleets, reports } = await loadState();
  const message = buildFleetScoreboardMessage({ fleets, reports });
  const discord = await postToDiscord(DISCORD_WEBHOOK_URL, message);

  res.json({
    ok: true,
    postedAt: new Date().toISOString(),
    discord,
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    error: err.message || "Server error",
  });
});

app.listen(PORT, () => {
  console.log(`Captain's Log backend listening on http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});