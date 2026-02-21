import type { AoiFeature } from "../types";

function firstPolygonFeature(geo: any): AoiFeature | null {
  if (!geo) return null;

  if (geo.type === "Feature" && geo.geometry && (geo.geometry.type === "Polygon" || geo.geometry.type === "MultiPolygon")) {
    return geo as AoiFeature;
  }

  if (geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    for (const f of geo.features) {
      if (f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon") return f as AoiFeature;
    }
  }

  // Certains parsers shapefile peuvent renvoyer GeometryCollection etc.
  return null;
}

export function validateAoi(geo: any): AoiFeature {
  const aoi = firstPolygonFeature(geo);
  if (!aoi) throw new Error("AOI invalide: aucun polygone/multipolygone détecté.");

  // garde-fou basique (éviter AOI vide)
  if (!aoi.geometry?.coordinates || (aoi.geometry.coordinates as any[]).length === 0) {
    throw new Error("AOI invalide: géométrie vide.");
  }

  return aoi;
}
