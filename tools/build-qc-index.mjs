import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import streamChainPkg from "stream-chain";
import streamJsonPkg from "stream-json";
import pickPkg from "stream-json/filters/Pick.js";
import streamArrayPkg from "stream-json/streamers/StreamArray.js";

const { chain } = streamChainPkg;
const { parser } = streamJsonPkg;
const { pick } = pickPkg;
const { streamArray } = streamArrayPkg;

const ROOT = process.cwd();

const LIDAR_SRC = path.join(ROOT, "data", "lidar_tuiles.geojson");
const MNT_SRC = path.join(ROOT, "data", "mnt_tuiles.geojson");

const OUT_LIDAR = path.join(ROOT, "public", "index", "lidar");
const OUT_MNT = path.join(ROOT, "public", "index", "mnt");

const CHUNK_SIZE = 0.25;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clearDir(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function chunkKey(lon, lat) {
  return `qk_${Math.round(lon * 4)}_${Math.round(lat * 4)}`;
}

function bbox(feature) {
  const geom = feature.geometry;
  if (!geom) throw new Error("Feature sans géométrie");

  let coords = [];
  if (geom.type === "Polygon") {
    coords = geom.coordinates.flat();
  } else if (geom.type === "MultiPolygon") {
    coords = geom.coordinates.flat(2);
  } else {
    throw new Error(`Type de géométrie non supporté: ${geom.type}`);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return [minX, minY, maxX, maxY];
}

function normalizeFeature(feature, product) {
  const props = { ...(feature.properties || {}) };

  props.product = product;
  props.tile_id =
    props.tile_id ||
    props.NOM_TUILE ||
    props.UUID ||
    props.id ||
    `tile_${Math.random().toString(36).slice(2, 10)}`;

  props.url =
    props.url ||
    props.TELECHARGEMENT_TUILE ||
    props.URL ||
    "";

  props.provider = props.provider || "QC";

  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: props,
  };
}

async function writeFeatureCollectionFromNdjson(ndjsonPath, outPath) {
  ensureDir(path.dirname(outPath));

  const ws = fs.createWriteStream(outPath, { encoding: "utf8" });
  ws.write('{"type":"FeatureCollection","features":[');

  let first = true;
  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!first) ws.write(",");
    ws.write(line);
    first = false;
  }

  ws.write("]}");

  await new Promise((resolve, reject) => {
    ws.end(resolve);
    ws.on("error", reject);
  });
}

async function buildIndex(srcFile, outDir, product) {
  console.log(`Loading: ${srcFile}`);

  const tmpDir = path.join(outDir, "_tmp");
  clearDir(outDir);
  ensureDir(outDir);
  ensureDir(tmpDir);
  ensureDir(path.join(outDir, "chunks"));

  const chunkMeta = new Map();
  const chunkStreams = new Map();

  const pipeline = chain([
    fs.createReadStream(srcFile),
    parser(),
    pick({ filter: "features" }),
    streamArray(),
  ]);

  let featureCount = 0;

  for await (const { value } of pipeline) {
    const f = normalizeFeature(value, product);
    const [minX, minY, maxX, maxY] = bbox(f);

    const lonStart = Math.floor(minX / CHUNK_SIZE) * CHUNK_SIZE;
    const latStart = Math.floor(minY / CHUNK_SIZE) * CHUNK_SIZE;
    const lonEnd = Math.floor(maxX / CHUNK_SIZE) * CHUNK_SIZE;
    const latEnd = Math.floor(maxY / CHUNK_SIZE) * CHUNK_SIZE;

    for (let lon = lonStart; lon <= lonEnd + 1e-9; lon += CHUNK_SIZE) {
      for (let lat = latStart; lat <= latEnd + 1e-9; lat += CHUNK_SIZE) {
        const id = chunkKey(lon, lat);
        const chunkPath = `chunks/${id}.json`;
        const bboxChunk = [lon, lat, lon + CHUNK_SIZE, lat + CHUNK_SIZE];

        if (!chunkMeta.has(id)) {
          chunkMeta.set(id, {
            id,
            bbox: bboxChunk,
            path: chunkPath,
          });
        }

        const tmpFile = path.join(tmpDir, `${id}.ndjson`);

        if (!chunkStreams.has(id)) {
          chunkStreams.set(
            id,
            fs.createWriteStream(tmpFile, { flags: "a", encoding: "utf8" })
          );
        }

        chunkStreams.get(id).write(JSON.stringify(f) + "\n");
      }
    }

    featureCount++;
    if (featureCount % 10000 === 0) {
      console.log(`[${product}] features traitées: ${featureCount}`);
    }
  }

  for (const ws of chunkStreams.values()) {
    await new Promise((resolve, reject) => {
      ws.end(resolve);
      ws.on("error", reject);
    });
  }

  const chunks = [...chunkMeta.values()].sort((a, b) => a.id.localeCompare(b.id));

  for (const chunk of chunks) {
    const ndjsonPath = path.join(tmpDir, `${chunk.id}.ndjson`);
    const outPath = path.join(outDir, chunk.path);
    await writeFeatureCollectionFromNdjson(ndjsonPath, outPath);
  }

  fs.writeFileSync(
    path.join(outDir, "grid.json"),
    JSON.stringify(
      {
        version: new Date().toISOString().slice(0, 10),
        chunkSizeDeg: CHUNK_SIZE,
        chunks,
      },
      null,
      2
    ),
    "utf8"
  );

  clearDir(tmpDir);

  console.log(`[${product}] total features: ${featureCount}`);
  console.log(`[${product}] total chunks: ${chunks.length}`);
}

if (!fs.existsSync(LIDAR_SRC)) {
  throw new Error(`Fichier introuvable: ${LIDAR_SRC}`);
}
if (!fs.existsSync(MNT_SRC)) {
  throw new Error(`Fichier introuvable: ${MNT_SRC}`);
}

await buildIndex(LIDAR_SRC, OUT_LIDAR, "lidar");
await buildIndex(MNT_SRC, OUT_MNT, "mnt");

console.log("Index generation complete");