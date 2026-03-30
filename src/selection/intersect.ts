import type { AoiFeature, TileFeature } from "../types";
import booleanIntersects from "@turf/boolean-intersects";

function isPolygonLikeFeature(feature: any): boolean {
  const type = feature?.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

function getTileId(tile: TileFeature): string {
  const props = tile?.properties as Record<string, any> | undefined;
  return String(props?.tile_id ?? props?.NOM_TUILE ?? "unknown");
}

function getProduct(tile: TileFeature): string {
  const props = tile?.properties as Record<string, any> | undefined;
  return String(props?.product ?? "").toLowerCase();
}

export function intersectAoiWithTiles(
  aoi: AoiFeature,
  tiles: TileFeature[]
): TileFeature[] {
  if (!isPolygonLikeFeature(aoi)) {
    console.error("AOI invalide ou non polygonale :", aoi);
    return [];
  }

  const selected: TileFeature[] = [];

  for (const tile of tiles) {
    if (!isPolygonLikeFeature(tile)) {
      console.warn("Tuile ignorée (géométrie non polygonale) :", tile?.properties);
      continue;
    }

    try {
      if (booleanIntersects(aoi as any, tile as any)) {
        selected.push(tile);
      }
    } catch (err) {
      console.warn("Erreur booleanIntersects sur tuile :", tile?.properties, err);
    }
  }

  const seen = new Set<string>();

  return selected.filter((tile) => {
    const key = `${getProduct(tile)}::${getTileId(tile)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}