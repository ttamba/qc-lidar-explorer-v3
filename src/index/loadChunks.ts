import type { GridIndex, TileFeature, TileFC } from "../types";

type Product = "lidar" | "mnt";

const gridPromiseCache = new Map<Product, Promise<GridIndex>>();
const gridResolvedCache = new Map<Product, GridIndex>();

function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number]
) {
  // a: view bbox, b: chunk bbox
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function perfMark(name: string) {
  if (!import.meta.env.DEV) return;
  performance.mark(name);
}

function perfMeasure(name: string, start: string, end: string) {
  if (!import.meta.env.DEV) return;

  try {
    performance.measure(name, start, end);
    const entries = performance.getEntriesByName(name);
    const last = entries.at(-1);
    if (last) {
      console.log(`[perf] ${name}: ${last.duration.toFixed(1)} ms`);
    }
  } catch {
    // ignore
  } finally {
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(name);
  }
}

async function getGridIndex(product: Product): Promise<GridIndex> {
  const cachedResolved = gridResolvedCache.get(product);
  if (cachedResolved) return cachedResolved;

  const cachedPromise = gridPromiseCache.get(product);
  if (cachedPromise) return cachedPromise;

  const promise = (async () => {
    const baseUrl = import.meta.env.BASE_URL;
    const gridUrl = `${baseUrl}index/${product}/grid.json`;

    perfMark(`loadChunks:${product}:gridFetch:start`);

    const gridRes = await fetch(gridUrl);
    if (!gridRes.ok) {
      throw new Error(`Impossible de charger grid.json pour ${product}.`);
    }

    const grid = (await gridRes.json()) as GridIndex;

    perfMark(`loadChunks:${product}:gridFetch:end`);
    perfMeasure(
      `loadChunks:${product}:gridFetch`,
      `loadChunks:${product}:gridFetch:start`,
      `loadChunks:${product}:gridFetch:end`
    );

    gridResolvedCache.set(product, grid);
    return grid;
  })();

  gridPromiseCache.set(product, promise);

  try {
    return await promise;
  } catch (error) {
    gridPromiseCache.delete(product);
    throw error;
  }
}

export function clearLoadChunksCaches() {
  gridPromiseCache.clear();
  gridResolvedCache.clear();
}

export async function loadTilesForBBox(
  product: Product,
  bbox: [number, number, number, number],
  cache: Map<string, TileFeature[]>
): Promise<TileFeature[]> {
  perfMark(`loadChunks:${product}:total:start`);

  const baseUrl = import.meta.env.BASE_URL;

  perfMark(`loadChunks:${product}:gridAccess:start`);
  const grid = await getGridIndex(product);
  perfMark(`loadChunks:${product}:gridAccess:end`);
  perfMeasure(
    `loadChunks:${product}:gridAccess`,
    `loadChunks:${product}:gridAccess:start`,
    `loadChunks:${product}:gridAccess:end`
  );

  perfMark(`loadChunks:${product}:chunkFilter:start`);
  const wanted = grid.chunks.filter((c) => bboxIntersects(bbox, c.bbox));
  perfMark(`loadChunks:${product}:chunkFilter:end`);
  perfMeasure(
    `loadChunks:${product}:chunkFilter`,
    `loadChunks:${product}:chunkFilter:start`,
    `loadChunks:${product}:chunkFilter:end`
  );

  let chunkCacheHits = 0;
  let chunkFetches = 0;
  let fetchedFeaturesCount = 0;

  perfMark(`loadChunks:${product}:chunksLoad:start`);

  const chunkResults = await Promise.all(
    wanted.map(async (chunk) => {
      const chunkPath = `${baseUrl}index/${product}/${chunk.path}`;

      const cached = cache.get(chunkPath);
      if (cached) {
        chunkCacheHits += 1;
        return cached;
      }

      chunkFetches += 1;

      const r = await fetch(chunkPath);
      if (!r.ok) {
        return [] as TileFeature[];
      }

      const fc = (await r.json()) as TileFC;
      const features = (fc.features ?? []) as TileFeature[];

      // garde-fou: product cohérent
      for (const f of features) {
        if (!f.properties?.product) {
          (f as any).properties.product = product;
        }
      }

      fetchedFeaturesCount += features.length;
      cache.set(chunkPath, features);

      return features;
    })
  );

  perfMark(`loadChunks:${product}:chunksLoad:end`);
  perfMeasure(
    `loadChunks:${product}:chunksLoad`,
    `loadChunks:${product}:chunksLoad:start`,
    `loadChunks:${product}:chunksLoad:end`
  );

  perfMark(`loadChunks:${product}:flatten:start`);
  const out = chunkResults.flat();
  perfMark(`loadChunks:${product}:flatten:end`);
  perfMeasure(
    `loadChunks:${product}:flatten`,
    `loadChunks:${product}:flatten:start`,
    `loadChunks:${product}:flatten:end`
  );

  if (import.meta.env.DEV) {
    console.log(`[perf] loadChunks:${product}:stats`, {
      bbox,
      gridChunkCount: grid.chunks.length,
      wantedChunkCount: wanted.length,
      chunkCacheHits,
      chunkFetches,
      fetchedFeaturesCount,
      returnedFeaturesCount: out.length,
    });
  }

  perfMark(`loadChunks:${product}:total:end`);
  perfMeasure(
    `loadChunks:${product}:total`,
    `loadChunks:${product}:total:start`,
    `loadChunks:${product}:total:end`
  );

  return out;
}