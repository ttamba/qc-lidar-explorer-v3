import fs from "node:fs";
import path from "node:path";

const CHUNK_SIZE_DEG = 0.25;

// ---------- utils ----------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function roundCoord(v, n = 6) {
  return Number(v.toFixed(n));
}

function featureBBox(feature) {
  const geom = feature?.geometry;
  if (!geom) throw new Error("Feature sans geometry");

  let coords = [];

  if (geom.type === "Polygon") {
    coords = geom.coordinates.flat(1);
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

  if (!props.tile_id) {
    props.tile_id =
      props.id ||
      props.tile ||
      props.name ||
      props.nom ||
      `tile_${Math.random().toString(36).slice(2, 10)}`;
  }

  props.product = product;

  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: props,
  };
}

function chunkId(minLon, minLat) {
  // même logique que votre exemple existant
  return `qk_${Math.round(minLon * 4)}_${Math.round(minLat * 4)}`;
}

function chunkBounds(minLon, minLat, sizeDeg) {
  return [
    roundCoord(minLon),
    roundCoord(minLat),
    roundCoord(minLon + sizeDeg),
    roundCoord(minLat + sizeDeg),
  ];
}

function featureIntersectsChunk(fBbox, cBbox) {
  return !(
    fBbox[2] < cBbox[0] ||
    fBbox[0] > cBbox[2] ||
    fBbox[3] < cBbox[1] ||
    fBbox[1] > cBbox[3]
  );
}

function buildChunks(features, product, chunkSizeDeg = CHUNK_SIZE_DEG) {
  const byChunk = new Map();

  for (const f of features) {
    const bbox = featureBBox(f);
    const [minX, minY, maxX, maxY] = bbox;

    const startLon = Math.floor(minX / chunkSizeDeg) * chunkSizeDeg;
    const startLat = Math.floor(minY / chunkSizeDeg) * chunkSizeDeg;
    const endLon = Math.floor(maxX / chunkSizeDeg) * chunkSizeDeg;
    const endLat = Math.floor(maxY / chunkSizeDeg) * chunkSizeDeg;

    for (let lon = startLon; lon <= endLon + 1e-9; lon += chunkSizeDeg) {
      for (let lat = startLat; lat <= endLat + 1e-9; lat += chunkSizeDeg) {
        const cb = chunkBounds(lon, lat, chunkSizeDeg);
        if (!featureIntersectsChunk(bbox, cb)) continue;

        const id = chunkId(lon, lat);
        if (!byChunk.has(id)) {
          byChunk.set(id, {
            id,
            bbox: cb,
            path: `chunks/${id}.json`,
            features: [],
          });
        }
        byChunk.get(id).features.push(f);
      }
    }
  }

  return [...byChunk.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function writeIndex(product, sourceFile, outRoot) {
  const fc = readJson(sourceFile);

  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error(`${sourceFile} doit être un FeatureCollection GeoJSON`);
  }

  const features = fc.features.map((f) => normalizeFeature(f, product));
  const chunks = buildChunks(features, product, CHUNK_SIZE_DEG);

  const productRoot = path.join(outRoot, product);
  const chunksRoot = path.join(productRoot, "chunks");

  ensureDir(chunksRoot);

  for (const chunk of chunks) {
    writeJson(path.join(productRoot, chunk.path), {
      type: "FeatureCollection",
      features: chunk.features,
    });
  }

  writeJson(path.join(productRoot, "grid.json"), {
    version: new Date().toISOString().slice(0, 10),
    chunkSizeDeg: CHUNK_SIZE_DEG,
    chunks: chunks.map(({ id, bbox, path }) => ({ id, bbox, path })),
  });

  console.log(`[${product}] features=${features.length}, chunks=${chunks.length}`);
}

// ---------- main ----------

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "public", "index");

const lidarSrc = path.join(DATA_DIR, "lidar_tiles.geojson");
const mntSrc = path.join(DATA_DIR, "mnt_tiles.geojson");

if (!fs.existsSync(lidarSrc)) {
  throw new Error(`Fichier introuvable: ${lidarSrc}`);
}
if (!fs.existsSync(mntSrc)) {
  throw new Error(`Fichier introuvable: ${mntSrc}`);
}

writeIndex("lidar", lidarSrc, OUT_DIR);
writeIndex("mnt", mntSrc, OUT_DIR);

console.log("Index complets générés dans public/index");