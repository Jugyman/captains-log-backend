function clean(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") return fallback;
  return value;
}

function shortShipType(ship) {
  return ship.shipTypeLabel || `Type ${ship.shipType || "?"}`;
}

function scoreFind(ship) {
  let score = 0;

  score += Number(ship.lengthM || 0) * 2;
  score += Number(ship.draughtM || 0) * 20;

  const type = Number(ship.shipType || 0);

  if ([51, 52, 55, 58].includes(type)) score += 250;
  if ([30, 31, 32, 33, 34, 35, 36, 37, 40, 50, 53, 54].includes(type)) score += 150;
  if (ship.destination) score += 50;
  if (ship.flagCountry && ship.flagCountry !== "Unknown") score += 25;
  if (ship.name) score += 100;

  return score;
}

function formatFind(ship, index) {
  const name = ship.name || `MMSI ${ship.mmsi || ship.decodedMmsi || "unknown"}`;
  const type = shortShipType(ship);
  const flag = clean(ship.flagCountry, "Unknown flag");
  const length = ship.lengthM ? `${ship.lengthM}m` : null;
  const draught = ship.draughtM ? `${ship.draughtM}m draught` : null;
  const dest = ship.destination ? `→ ${ship.destination}` : null;

  const details = [length, type, draught, flag, dest].filter(Boolean).join(" • ");

  return `${index + 1}) **${name}** — ${details}`;
}

function uniqueList(items, max = 6) {
  return [...new Set(items.filter(Boolean))].slice(0, max);
}

export function buildDiscordMessage({ report, xp, breakdown }) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  const fleet = report.fleet || "No Fleet";
  const strongest = report.strongestSignal ?? "n/a";

  const flags = uniqueList(
    ships
      .map((s) => s.flagCountry)
      .filter((f) => f && f !== "Unknown"),
    5
  );

  const destinations = uniqueList(
    ships
      .map((s) => s.destination)
      .filter(Boolean),
    5
  );

  const topFinds = [...ships]
    .filter((s) => s.name || s.mmsi || s.decodedMmsi)
    .sort((a, b) => scoreFind(b) - scoreFind(a))
    .slice(0, 7);

  const lines = [
    `📘 **Captain’s Log — ${report.station}**`,
    `⚓ Fleet: **${fleet}**`,
    "",
    `🏆 XP earned: **${xp}**`,
    `🚢 Unique ships: **${breakdown.uniqueNamedShips}**`,
    `🧩 Completed Type 5: **${breakdown.completedType5}**`,
    `📡 Strongest signal: **${strongest}**`,
  ];

  if (flags.length) {
    lines.push(`🌍 Flags found: **${flags.join(", ")}**`);
  }

  if (destinations.length) {
    lines.push(`⚓ Destinations: **${destinations.join(", ")}**`);
  }

  if (breakdown.newShipDiscoveries || breakdown.newDestinationDiscoveries) {
    lines.push("");
    lines.push(
      `✨ Discoveries: **${breakdown.newShipDiscoveries || 0}** new ships, **${
        breakdown.newDestinationDiscoveries || 0
      }** new destinations`
    );
  }

  lines.push("");

  if (topFinds.length) {
    lines.push("🔥 **Top finds:**");
    lines.push(...topFinds.map((ship, index) => formatFind(ship, index)));
  } else {
    lines.push("No named ships detected today.");
  }

  return {
    content: lines.join("\n"),
  };
}

export async function postToDiscord(webhookUrl, payload) {
  if (!webhookUrl) return { skipped: true, reason: "No DISCORD_WEBHOOK_URL set" };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed ${res.status}: ${text}`);
  }

  return { ok: true };
}