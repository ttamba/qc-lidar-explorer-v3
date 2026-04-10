import type { AoiFeature, TileFeature } from "../types";
import booleanIntersects from "@turf/boolean-intersects";

/**
 * Vérifie si la feature est polygonale
 */
function isPolygonLikeFeature(feature: any): boolean {
  const type = feature?.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

/**
 * Extraction bbox [minX, minY, maxX, maxY]
 */
function getBbox(feature: any): [number, number, number, number] | null {
  const coords = feature?.geometry?.coordinates;
  if (!coords) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const scan = (arr: any): void => {
    if (!Array.isArray(arr) || arr.length === 0) return;

    if (typeof arr[0] === "number") {
      const [x, y] = arr as [number, number];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return;
    }

    for (const child of arr) {
      scan(child);
    }
  };

  scan(coords);

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return [minX, minY, maxX, maxY];
}

/**
 * Test bbox intersection ultra rapide
 */
function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function getTileId(tile: TileFeature): string {
  const props = tile?.properties as Record<string, any> | undefined;
  return String(props?.tile_id ?? props?.NOM_TUILE ?? "unknown");
}

function getProduct(tile: TileFeature): string {
  const props = tile?.properties as Record<string, any> | undefined;
  return String(props?.product ?? "").toLowerCase();
}

export type WorkerCandidateTile = {
  id: string;
  geometry: GeoJSON.Geometry;
};

export function buildIntersectPayload(
  aoi: AoiFeature,
  tiles: TileFeature[]
): {
  aoi: AoiFeature;
  candidates: WorkerCandidateTile[];
} {
  if (!isPolygonLikeFeature(aoi)) {
    console.error("AOI invalide ou non polygonale :", aoi);
    return { aoi, candidates: [] };
  }

  const aoiBbox = getBbox(aoi);
  if (!aoiBbox) {
    console.error("Impossible de calculer la bbox de l'AOI :", aoi);
    return { aoi, candidates: [] };
  }

  const candidates: WorkerCandidateTile[] = [];

  for (const tile of tiles) {
    if (!isPolygonLikeFeature(tile)) continue;

    const tileBbox = getBbox(tile);
    if (!tileBbox) continue;

    if (!bboxIntersects(aoiBbox, tileBbox)) continue;

    candidates.push({
      id: getTileId(tile),
      geometry: tile.geometry,
    });
  }

  return { aoi, candidates };
}

/**
 * API rétrocompatible utilisée actuellement par MapView.tsx
 * Optimisation incluse :
 * - préfiltrage bbox agressif
 * - intersection fine uniquement sur candidats
 * - déduplication finale inchangée
 */
export function intersectAoiWithTiles(
  aoi: AoiFeature,
  tiles: TileFeature[]
): TileFeature[] {
  if (!isPolygonLikeFeature(aoi)) {
    console.error("AOI invalide ou non polygonale :", aoi);
    return [];
  }

  const aoiBbox = getBbox(aoi);
  if (!aoiBbox) {
    console.error("Impossible de calculer la bbox de l'AOI :", aoi);
    return [];
  }

  const selected: TileFeature[] = [];

  for (const tile of tiles) {
    if (!isPolygonLikeFeature(tile)) {
      console.warn("Tuile ignorée (géométrie non polygonale) :", tile?.properties);
      continue;
    }

    const tileBbox = getBbox(tile);
    if (!tileBbox) continue;

    // Préfiltrage bbox très peu coûteux
    if (!bboxIntersects(aoiBbox, tileBbox)) continue;

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