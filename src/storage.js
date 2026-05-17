import fs from "fs/promises";
import path from "path";

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

export function dataFiles(dataDir) {
  return {
    stations: path.join(dataDir, "stations.json"),
    reports: path.join(dataDir, "reports.json"),
    fleets: path.join(dataDir, "fleets.json"),
    globals: path.join(dataDir, "globals.json"),
  };
}
