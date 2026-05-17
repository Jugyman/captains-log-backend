const FLEET_NAMES = [
  "Atlantic Fleet",
  "Ghost Armada",
  "Northern Watch",
  "Deepwater Syndicate",
  "Lighthouse Union",
  "Black Current",
];

export function defaultFleets() {
  return FLEET_NAMES.map((name) => ({
    name,
    allTimeXp: 0,
    dailyXp: {},
    stationCount: 0,
  }));
}

export function normaliseShipType(shipType) {
  const n = Number(shipType || 0);
  if (!Number.isFinite(n)) return 0;
  if ([30,31,32,33,34,35,36,37,40,50,51,52,53,54,55,58,60,70,80,90].includes(n)) return n;
  return Math.floor(n / 10) * 10;
}

export function calculateLocalXp(report, globalSeen = { shipNames: [], destinations: [] }) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  const completedType5 = Number(report.completedType5Messages || 0);

  const uniqueNamedShips = new Set(
    ships.map((s) => String(s.name || "").trim().toUpperCase()).filter(Boolean)
  );

  const uniqueFlags = new Set(
    ships.map((s) => String(s.flagCountry || s.flag || "").trim()).filter(Boolean)
  );

  const knownShips = new Set((globalSeen.shipNames || []).map((x) => String(x).toUpperCase()));
  const knownDests = new Set((globalSeen.destinations || []).map((x) => String(x).toUpperCase()));

  const newShips = [...uniqueNamedShips].filter((name) => !knownShips.has(name));
  const destinations = new Set(
    ships.map((s) => String(s.destination || "").trim().toUpperCase()).filter(Boolean)
  );
  const newDestinations = [...destinations].filter((dest) => !knownDests.has(dest));

  const xp =
    uniqueNamedShips.size * 100 +
    completedType5 * 1 +
    newShips.length * 50 +
    newDestinations.length * 50 +
    uniqueFlags.size * 25;

  return {
    xp,
    breakdown: {
      uniqueNamedShips: uniqueNamedShips.size,
      completedType5,
      newShipDiscoveries: newShips.length,
      newDestinationDiscoveries: newDestinations.length,
      uniqueFlags: uniqueFlags.size,
    },
    newShips,
    newDestinations,
  };
}

export function updateGlobalSeen(globals, report) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  globals.shipNames ||= [];
  globals.destinations ||= [];
  globals.mmsis ||= [];

  const shipNames = new Set(globals.shipNames.map((x) => String(x).toUpperCase()));
  const destinations = new Set(globals.destinations.map((x) => String(x).toUpperCase()));
  const mmsis = new Set(globals.mmsis.map(String));

  for (const ship of ships) {
    const name = String(ship.name || "").trim().toUpperCase();
    const dest = String(ship.destination || "").trim().toUpperCase();
    const mmsi = String(ship.mmsi || ship.decodedMmsi || "").trim();
    if (name) shipNames.add(name);
    if (dest) destinations.add(dest);
    if (mmsi) mmsis.add(mmsi);
  }

  globals.shipNames = [...shipNames].sort();
  globals.destinations = [...destinations].sort();
  globals.mmsis = [...mmsis].sort();
  return globals;
}

export function getBottomThreeFleetNames(fleets) {
  return [...fleets]
    .sort((a, b) => (a.allTimeXp || 0) - (b.allTimeXp || 0) || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((f) => f.name);
}

export function canJoinFleet(fleets, requestedFleet) {
  const fleet = fleets.find((f) => f.name === requestedFleet);
  if (!fleet) return { ok: false, reason: "Unknown fleet" };
  if ((fleet.stationCount || 0) < 5) return { ok: true, reason: "First 5 station exception" };
  const bottomThree = getBottomThreeFleetNames(fleets);
  if (bottomThree.includes(requestedFleet)) return { ok: true, reason: "Bottom 3 all-time XP fleet" };
  return { ok: false, reason: `New stations can only join: ${bottomThree.join(", ")}` };
}

export function applyFleetXp(fleets, fleetName, date, xp) {
  const fleet = fleets.find((f) => f.name === fleetName);
  if (!fleet) return fleets;
  fleet.allTimeXp = Number(fleet.allTimeXp || 0) + Number(xp || 0);
  fleet.dailyXp ||= {};
  fleet.dailyXp[date] = Number(fleet.dailyXp[date] || 0) + Number(xp || 0);
  return fleets;
}
