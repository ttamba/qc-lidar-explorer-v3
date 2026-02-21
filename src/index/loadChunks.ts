import type { GridIndex, TileFeature, TileFC } from "../types";

function bboxIntersects(a: [number, number, number, number], b: [number, number, number, number]) {
  // a: view bbox, b: chunk bbox
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export async function loadTilesForBBox(
  product: "lidar" | "mnt",
  bbox: [number, number, number, number],
  cache: Map<string, TileFeature[]>
): Promise<TileFeature[]> {
  const baseUrl = import.meta.env.BASE_URL; // respects vite base path
  const gridUrl = `${baseUrl}index/${product}/grid.json`;

  const gridRes = await fetch(gridUrl);
  if (!gridRes.ok) throw new Error(`Impossible de charger grid.json pour ${product}.`);
  const grid = (await gridRes.json()) as GridIndex;

  const wanted = grid.chunks.filter((c) => bboxIntersects(bbox, c.bbox));

  const out: TileFeature[] = [];
  await Promise.all(
    wanted.map(async (chunk) => {
      const chunkPath = `${baseUrl}index/${product}/${chunk.path}`;

      const cached = cache.get(chunkPath);
      if (cached) {
        out.push(...cached);
        return;
      }

      const r = await fetch(chunkPath);
      if (!r.ok) return;

      const fc = (await r.json()) as TileFC;
      const features = (fc.features ?? []) as TileFeature[];

      // garde-fou: product cohérent
      for (const f of features) {
        if (!f.properties?.product) (f as any).properties.product = product;
      }

      cache.set(chunkPath, features);
      out.push(...features);
    })
  );

  return out;
}
