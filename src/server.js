import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { buildDiscordMessage, postToDiscord } from "./discord.js";
import { dataFiles, ensureDir, readJson, writeJson } from "./storage.js";
import {
  applyFleetXp,
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
const POST_TO_DISCORD = String(process.env.POST_TO_DISCORD || "true").toLowerCase() === "true";

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
    return res.status(401).json({ ok: false, error: "Invalid or missing Captain's Log API key" });
  }
  next();
}

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function reportKey(report) {
  return `${report.stationId || report.station}|${report.date}`;
}

async function loadState() {
  await ensureDir(DATA_DIR);
  const fleets = await readJson(files.fleets, defaultFleets());
  const stations = await readJson(files.stations, []);
  const reports = await readJson(files.reports, []);
  const globals = await readJson(files.globals, { shipNames: [], destinations: [], mmsis: [] });
  return { fleets, stations, reports, globals };
}

app.get("/health", async (_req, res) => {
  res.json({ ok: true, service: "captains-log-backend", time: new Date().toISOString() });
});

app.get("/fleets", async (_req, res) => {
  const { fleets } = await loadState();
  res.json({ ok: true, bottomThree: getBottomThreeFleetNames(fleets), fleets });
});

app.post("/stations/register", requireApiKey, async (req, res) => {
  const { stationId, stationName, captainDiscordId, fleet } = req.body || {};
  if (!requiredString(stationId) || !requiredString(stationName) || !requiredString(fleet)) {
    return res.status(400).json({ ok: false, error: "stationId, stationName and fleet are required" });
  }

  const state = await loadState();
  const existing = state.stations.find((s) => s.stationId === stationId);

  if (!existing) {
    const joinCheck = canJoinFleet(state.fleets, fleet);
    if (!joinCheck.ok) {
      return res.status(400).json({ ok: false, error: joinCheck.reason, bottomThree: getBottomThreeFleetNames(state.fleets) });
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
    if (fleetRow) fleetRow.stationCount = Number(fleetRow.stationCount || 0) + 1;
  } else {
    existing.stationName = stationName;
    existing.captainDiscordId = captainDiscordId || existing.captainDiscordId || "";
  }

  await writeJson(files.stations, state.stations);
  await writeJson(files.fleets, state.fleets);
  res.json({ ok: true, station: state.stations.find((s) => s.stationId === stationId), bottomThree: getBottomThreeFleetNames(state.fleets) });
});

app.post("/reports/upload", requireApiKey, async (req, res) => {
  const body = req.body || {};
  const report = body.report || body;

  if (!requiredString(report.station) || !requiredString(report.date) || !requiredString(report.source)) {
    return res.status(400).json({ ok: false, error: "report.station, report.date and report.source are required" });
  }
  if (!Array.isArray(report.ships)) {
    return res.status(400).json({ ok: false, error: "report.ships must be an array" });
  }

  report.stationId ||= body.stationId || report.station;
  report.captainDiscordId ||= body.captainDiscordId || "";
  report.fleet ||= body.fleet || "";

  const state = await loadState();
  const key = reportKey(report);
  const duplicate = state.reports.find((r) => r.key === key);
  if (duplicate) {
    return res.status(409).json({ ok: false, error: "Duplicate report for this station/date", existing: duplicate });
  }

  if (report.fleet && !state.fleets.find((f) => f.name === report.fleet)) {
    return res.status(400).json({ ok: false, error: "Unknown fleet" });
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

  state.reports.push(storedReport);
  state.globals = updateGlobalSeen(state.globals, report);

  if (report.fleet) {
    applyFleetXp(state.fleets, report.fleet, report.date, scoring.xp);
  }

  const station = state.stations.find((s) => s.stationId === report.stationId);
  if (station) station.allTimeXp = Number(station.allTimeXp || 0) + scoring.xp;

  await writeJson(files.reports, state.reports);
  await writeJson(files.globals, state.globals);
  await writeJson(files.fleets, state.fleets);
  await writeJson(files.stations, state.stations);

  let discord = { skipped: true };
  if (POST_TO_DISCORD) {
    const message = buildDiscordMessage({ report, xp: scoring.xp, breakdown: scoring.breakdown });
    discord = await postToDiscord(DISCORD_WEBHOOK_URL, message);
  }

  res.json({ ok: true, xp: scoring.xp, scoring: scoring.breakdown, newShips: scoring.newShips, newDestinations: scoring.newDestinations, discord });
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

  res.json({ ok: true, count: rows.length, reports: rows });
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
    fleets: [...fleets].sort((a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)),
    stations: [...stations].sort((a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)),
    daily: {
      fleets: dailyFleets,
      stations: dailyStations,
    },
    bottomThree: getBottomThreeFleetNames(fleets),
  });
});

app.get("/records", async (_req, res) => {
  const { reports } = await loadState();

  const ships = reports.flatMap((r) =>
    (r.report?.ships || []).map((ship) => ({
      ...ship,
      station: r.station,
      stationId: r.stationId,
      fleet: r.fleet,
      date: r.date,
      uploadedAt: r.uploadedAt,
    }))
  );

  const withNumber = (field) =>
    ships.filter((s) => Number.isFinite(Number(s[field])) && Number(s[field]) > 0);

  const maxBy = (field) =>
    withNumber(field).sort((a, b) => Number(b[field]) - Number(a[field]))[0] || null;

  const minBy = (field) =>
    withNumber(field).sort((a, b) => Number(a[field]) - Number(b[field]))[0] || null;

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
    .map((r) => ({ station: r.station, stationId: r.stationId, fleet: r.fleet, xp: r.xp }))
    .sort((a, b) => b.xp - a.xp);

  const fleetRows = fleets
    .map((f) => ({ name: f.name, xp: Number(f.dailyXp?.[date] || 0), allTimeXp: Number(f.allTimeXp || 0) }))
    .sort((a, b) => b.xp - a.xp);

  res.json({ ok: true, date, stations: stationRows, fleets: fleetRows });
});

app.get("/leaderboard/all-time", async (_req, res) => {
  const { fleets, stations } = await loadState();
  res.json({
    ok: true,
    fleets: [...fleets].sort((a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)),
    stations: [...stations].sort((a, b) => Number(b.allTimeXp || 0) - Number(a.allTimeXp || 0)),
    bottomThree: getBottomThreeFleetNames(fleets),
  });
});


function buildFleetScoreboardMessage({ fleets, reports }) {
  const today = new Date().toISOString().slice(0, 10);

  const fleetRows = [...fleets]
    .map((f) => ({
      name: f.name,
      xp: Number(f.dailyXp?.[today] || 0),
      allTimeXp: Number(f.allTimeXp || 0),
    }))
    .sort((a, b) => b.xp - a.xp);

  const stationRows = [...reports]
    .filter((r) => r.date === today)
    .map((r) => ({
      station: r.station,
      fleet: r.fleet || "No Fleet",
      xp: Number(r.xp || 0),
    }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 5);

  return {
    content: [
      `🏆 **Captain’s Log — Fleet Scoreboard**`,
      `📅 ${today}`,
      "",
      "**Fleet standings today:**",
      ...fleetRows.map((f, i) => `${i + 1}. **${f.name}** — ${f.xp} XP`),
      "",
      stationRows.length
        ? `**Top stations today:**\n${stationRows.map((s, i) => `${i + 1}. ${s.station} — ${s.xp} XP (${s.fleet})`).join("\n")}`
        : "**Top stations today:**\nNo station logs yet.",
      "",
      `🔻 **Bottom 3 open for new stations:**\n${getBottomThreeFleetNames(fleets).map((n) => `• ${n}`).join("\n")}`,
    ].join("\n"),
  };
}

app.post("/admin/post-fleet-scoreboard", requireApiKey, async (_req, res) => {
  const { fleets, reports } = await loadState();
  const message = buildFleetScoreboardMessage({ fleets, reports });
  const discord = await postToDiscord(DISCORD_WEBHOOK_URL, message);
  res.json({ ok: true, discord });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`Captain's Log backend listening on http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
