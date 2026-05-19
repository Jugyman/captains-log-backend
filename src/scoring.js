export function defaultFleets() {
  return [
    { name: "Atlantic Fleet", allTimeXp: 0, stationCount: 0, dailyXp: {} },
    { name: "Ghost Armada", allTimeXp: 0, stationCount: 0, dailyXp: {} },
    { name: "Northern Watch", allTimeXp: 0, stationCount: 0, dailyXp: {} },
    { name: "Deepwater Syndicate", allTimeXp: 0, stationCount: 0, dailyXp: {} },
    { name: "Lighthouse Union", allTimeXp: 0, stationCount: 0, dailyXp: {} },
    { name: "Black Current", allTimeXp: 0, stationCount: 0, dailyXp: {} },
  ];
}

export function getBottomThreeFleetNames(fleets) {
  return [...fleets]
    .sort((a, b) => Number(a.allTimeXp || 0) - Number(b.allTimeXp || 0))
    .slice(0, 3)
    .map((f) => f.name);
}

export function canJoinFleet(fleets, fleetName) {
  const fleet = fleets.find((f) => f.name === fleetName);

  if (!fleet) {
    return {
      ok: false,
      reason: "Unknown fleet",
    };
  }

  if (Number(fleet.stationCount || 0) < 5) {
    return {
      ok: true,
      reason: "bootstrap_phase",
    };
  }

  const bottomThree = getBottomThreeFleetNames(fleets);

  if (bottomThree.includes(fleetName)) {
    return {
      ok: true,
      reason: "bottom_3_rule",
    };
  }

  return {
    ok: false,
    reason: "New stations can only join one of the bottom 3 fleets by all-time XP",
  };
}

function normaliseText(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqueShips(report) {
  const ships = Array.isArray(report.ships) ? report.ships : [];
  const seen = new Set();
  const out = [];

  for (const ship of ships) {
    const key =
      normaliseText(ship.mmsi) ||
      normaliseText(ship.decodedMmsi) ||
      normaliseText(ship.name);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(ship);
  }

  return out;
}

function hasKnownFlag(ship) {
  return ship.flagCountry && ship.flagCountry !== "Unknown";
}

function isPassenger(ship) {
  const type = Number(ship.shipType || 0);
  return type >= 60 && type < 70;
}

function isTanker(ship) {
  const type = Number(ship.shipType || 0);
  return type >= 80 && type < 90;
}

function isServiceOrRescue(ship) {
  const type = Number(ship.shipType || 0);
  return [50, 51, 52, 53, 54, 55, 58].includes(type);
}

function isSpecialWorkboat(ship) {
  const type = Number(ship.shipType || 0);
  return [30, 31, 32, 33, 34, 35, 36, 37].includes(type);
}

function calculateShipBonuses(ship) {
  let xp = 0;
  const bonuses = [];

  if (isPassenger(ship)) {
    xp += 200;
    bonuses.push("passengerVessel");
  }

  if (isTanker(ship)) {
    xp += 150;
    bonuses.push("tankerVessel");
  }

  if (isServiceOrRescue(ship)) {
    xp += 300;
    bonuses.push("serviceOrRescueVessel");
  }

  if (isSpecialWorkboat(ship)) {
    xp += 400;
    bonuses.push("specialWorkboat");
  }

  const lengthM = Number(ship.lengthM || 0);

  if (lengthM >= 250) {
    xp += 300;
    bonuses.push("giantVessel250m");
  } else if (lengthM >= 180) {
    xp += 150;
    bonuses.push("largeVessel180m");
  }

  const draughtM = Number(ship.draughtM || 0);

  if (draughtM >= 10) {
    xp += 100;
    bonuses.push("deepDraught10m");
  }

  return { xp, bonuses };
}

export function calculateLocalXp(report, globals = {}) {
  const ships = uniqueShips(report);
  const completedType5Messages = Number(report.completedType5Messages || 0);

  const seenShipNames = new Set((globals.shipNames || []).map(normaliseText));
  const seenDestinations = new Set((globals.destinations || []).map(normaliseText));

  const uniqueNamedShips = ships.filter((s) => normaliseText(s.name)).length;
  const completedType5Xp = completedType5Messages;
  const uniqueShipXp = uniqueNamedShips * 100;

  let newShipDiscoveries = 0;
  let newDestinationDiscoveries = 0;
  let vesselTypeBonusXp = 0;
  let largeVesselBonusXp = 0;
  let deepDraughtBonusXp = 0;
  let rareFlagBonusXp = 0;

  const discoveredShips = [];
  const discoveredDestinations = [];
  const shipBonuses = [];

  const flagsToday = new Set();

  for (const ship of ships) {
    const name = normaliseText(ship.name);
    const destination = normaliseText(ship.destination);

    if (name && !seenShipNames.has(name)) {
      newShipDiscoveries += 1;
      discoveredShips.push(ship.name);
    }

    if (destination && !seenDestinations.has(destination)) {
      newDestinationDiscoveries += 1;
      discoveredDestinations.push(ship.destination);
    }

    if (hasKnownFlag(ship)) {
      flagsToday.add(ship.flagCountry);
    }

    const bonus = calculateShipBonuses(ship);

    if (bonus.xp > 0) {
      shipBonuses.push({
        name: ship.name || ship.mmsi || ship.decodedMmsi || "Unknown vessel",
        xp: bonus.xp,
        bonuses: bonus.bonuses,
      });
    }

    for (const bonusName of bonus.bonuses) {
      if (
        bonusName === "passengerVessel" ||
        bonusName === "tankerVessel" ||
        bonusName === "serviceOrRescueVessel" ||
        bonusName === "specialWorkboat"
      ) {
        if (bonusName === "passengerVessel") vesselTypeBonusXp += 200;
        if (bonusName === "tankerVessel") vesselTypeBonusXp += 150;
        if (bonusName === "serviceOrRescueVessel") vesselTypeBonusXp += 300;
        if (bonusName === "specialWorkboat") vesselTypeBonusXp += 400;
      }

      if (bonusName === "giantVessel250m") largeVesselBonusXp += 300;
      if (bonusName === "largeVessel180m") largeVesselBonusXp += 150;
      if (bonusName === "deepDraught10m") deepDraughtBonusXp += 100;
    }
  }

  rareFlagBonusXp = flagsToday.size * 25;

  const newShipDiscoveryXp = newShipDiscoveries * 150;
  const newDestinationDiscoveryXp = newDestinationDiscoveries * 100;

  const xp =
    uniqueShipXp +
    completedType5Xp +
    newShipDiscoveryXp +
    newDestinationDiscoveryXp +
    vesselTypeBonusXp +
    largeVesselBonusXp +
    deepDraughtBonusXp +
    rareFlagBonusXp;

  return {
    xp,
    newShips: discoveredShips,
    newDestinations: discoveredDestinations,
    breakdown: {
      uniqueNamedShips,
      uniqueShipXp,
      completedType5Messages,
      completedType5Xp,
      newShipDiscoveries,
      newShipDiscoveryXp,
      newDestinationDiscoveries,
      newDestinationDiscoveryXp,
      uniqueFlags: flagsToday.size,
      rareFlagBonusXp,
      vesselTypeBonusXp,
      largeVesselBonusXp,
      deepDraughtBonusXp,
      shipBonuses,
      totalXp: xp,
    },
  };
}

export function updateGlobalSeen(globals = {}, report) {
  const next = {
    shipNames: Array.isArray(globals.shipNames) ? [...globals.shipNames] : [],
    destinations: Array.isArray(globals.destinations) ? [...globals.destinations] : [],
    mmsis: Array.isArray(globals.mmsis) ? [...globals.mmsis] : [],
  };

  const shipNames = new Set(next.shipNames.map(normaliseText));
  const destinations = new Set(next.destinations.map(normaliseText));
  const mmsis = new Set(next.mmsis.map(normaliseText));

  for (const ship of uniqueShips(report)) {
    const name = normaliseText(ship.name);
    const destination = normaliseText(ship.destination);
    const mmsi = normaliseText(ship.mmsi || ship.decodedMmsi);

    if (name && !shipNames.has(name)) {
      next.shipNames.push(ship.name);
      shipNames.add(name);
    }

    if (destination && !destinations.has(destination)) {
      next.destinations.push(ship.destination);
      destinations.add(destination);
    }

    if (mmsi && !mmsis.has(mmsi)) {
      next.mmsis.push(String(ship.mmsi || ship.decodedMmsi));
      mmsis.add(mmsi);
    }
  }

  return next;
}

export function applyFleetXp(fleets, fleetName, date, xp) {
  const fleet = fleets.find((f) => f.name === fleetName);

  if (!fleet) return fleets;

  fleet.allTimeXp = Number(fleet.allTimeXp || 0) + Number(xp || 0);
  fleet.dailyXp ||= {};
  fleet.dailyXp[date] = Number(fleet.dailyXp[date] || 0) + Number(xp || 0);

  return fleets;
}