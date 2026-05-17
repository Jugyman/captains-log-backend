export function buildDiscordMessage({ report, xp, breakdown }) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  const topNames = ships.map((s) => s.name).filter(Boolean).slice(0, 8);
  const strongest = report.strongestSignal ?? "n/a";
  const fleet = report.fleet || "No Fleet";

  return {
    content: [
      `📘 **Captain’s Log — ${report.station}**`,
      `⚓ Fleet: **${fleet}**`,
      `🚢 Named ships: **${breakdown.uniqueNamedShips}**`,
      `🏆 XP earned: **${xp}**`,
      `📡 Strongest signal: **${strongest}**`,
      "",
      topNames.length ? `**Top catches:**\n${topNames.map((n) => `• ${n}`).join("\n")}` : "No named ships detected today.",
    ].join("\n"),
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
