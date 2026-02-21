import type { AoiFeature, TileFeature } from "../types";
import booleanIntersects from "@turf/boolean-intersects";

export function intersectAoiWithTiles(aoi: AoiFeature, tiles: TileFeature[]): TileFeature[] {
  const selected: TileFeature[] = [];
  for (const t of tiles) {
    try {
      if (booleanIntersects(aoi as any, t as any)) selected.push(t);
    } catch {
      // ignore geometry errors
    }
  }
  // dédoublonnage (au cas où chunks/produits se chevauchent)
  const seen = new Set<string>();
  return selected.filter((t) => {
    const key = `${t.properties.product}::${t.properties.tile_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
