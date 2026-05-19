function clean(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") return fallback;
  return value;
}

function roundSignal(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) return "n/a";

  return `${num.toFixed(1)} dB`;
}

function formatXp(value) {
  const num = Number(value || 0);
  return num.toLocaleString("en-GB");
}

function shipEmoji(ship) {
  const type = Number(ship.shipType || 0);

  if ([60, 61, 62, 69].includes(type)) return "🚢";
  if ([70, 71, 72, 73, 74, 79].includes(type)) return "📦";
  if ([80, 81, 82, 83, 84, 89].includes(type)) return "🛢";
  if ([30, 31, 32, 33, 34, 35, 36, 37].includes(type)) return "🛟";
  if ([50, 51, 52, 53, 54, 55, 58].includes(type)) return "⚓";

  return "🚤";
}

function shortShipType(ship) {
  return ship.shipTypeLabel || `Type ${ship.shipType || "?"}`;
}

function scoreFind(ship) {
  let score = 0;

  score += Number(ship.lengthM || 0) * 2;
  score += Number(ship.draughtM || 0) * 20;

  const type = Number(ship.shipType || 0);

  if ([51, 52, 55, 58].includes(type)) score += 300;
  if ([30, 31, 32, 33, 34, 35, 36, 37].includes(type)) score += 400;
  if ([60, 61, 62, 69].includes(type)) score += 200;

  if (ship.destination) score += 50;
  if (ship.flagCountry && ship.flagCountry !== "Unknown") score += 25;
  if (ship.name) score += 100;

  return score;
}

function formatFind(ship, index) {
  const emoji = shipEmoji(ship);
  const name = ship.name || `MMSI ${ship.mmsi || ship.decodedMmsi || "unknown"}`;
  const type = shortShipType(ship);
  const flag = clean(ship.flagCountry, "Unknown");
  const length = ship.lengthM ? `${ship.lengthM}m` : null;
  const draught = ship.draughtM ? `${ship.draughtM}m draught` : null;
  const dest = ship.destination ? `→ ${ship.destination}` : null;

  const details = [length, type, draught, flag, dest].filter(Boolean).join(" • ");

  return `${index + 1}) ${emoji} **${name}** — ${details}`;
}

function uniqueList(items, max = 5) {
  return [...new Set(items.filter(Boolean))].slice(0, max);
}

function largestShip(ships) {
  return [...ships]
    .filter((s) => Number(s.lengthM || 0) > 0)
    .sort((a, b) => Number(b.lengthM || 0) - Number(a.lengthM || 0))[0];
}

function rareShips(ships) {
  return ships.filter((s) => {
    const type = Number(s.shipType || 0);

    return [
      30, 31, 32, 33, 34, 35, 36, 37,
      50, 51, 52, 53, 54, 55, 58,
    ].includes(type);
  });
}

export function buildDiscordMessage({ report, xp, breakdown }) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  const fleet = report.fleet || "No Fleet";
  const strongest = roundSignal(report.strongestSignal);

  const flags = uniqueList(
    ships.map((s) => s.flagCountry).filter((f) => f && f !== "Unknown"),
    5
  );

  const destinations = uniqueList(
    ships.map((s) => s.destination).filter(Boolean),
    3
  );

  const topFinds = [...ships]
    .filter((s) => s.name || s.mmsi || s.decodedMmsi)
    .sort((a, b) => scoreFind(b) - scoreFind(a))
    .slice(0, 7);

  const biggest = largestShip(ships);
  const rares = rareShips(ships);

  const lines = [
    `📘 **Captain’s Log — ${report.station}**`,
    `⚓ Fleet: **${fleet}**`,
    "",
    `🏆 XP earned: **${formatXp(xp)}**`,
    `🚢 Unique ships: **${breakdown.uniqueNamedShips}**`,
    `📡 Strongest signal: **${strongest}**`,
  ];

  if (report.fleetRank) {
    lines.push(`🏴 Fleet rank today: **#${report.fleetRank}**`);
  }

  if (flags.length) {
    lines.push(`🌍 Flags found: **${flags.join(", ")}**`);
  }

  if (destinations.length) {
    lines.push(`⚓ Destinations: **${destinations.join(", ")}**`);
  }

  if (biggest) {
    lines.push(
      `👑 Largest vessel: **${biggest.name || biggest.mmsi}** — ${biggest.lengthM}m`
    );
  }

  if (breakdown.newShipDiscoveries || breakdown.newDestinationDiscoveries) {
    lines.push("");
    lines.push(
      `✨ Discoveries: **${breakdown.newShipDiscoveries || 0}** new ships, **${
        breakdown.newDestinationDiscoveries || 0
      }** new destinations`
    );
  }

  if (rares.length) {
    lines.push("");
    lines.push(`☢ Rare vessel bonus: **${rares.length}** special vessels detected`);
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
  if (!webhookUrl) {
    return {
      skipped: true,
      reason: "No DISCORD_WEBHOOK_URL set",
    };
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    throw new Error(`Discord webhook failed ${res.status}: ${text}`);
  }

  return { ok: true };
}