import type { AoiFeature } from "../types";

function firstPolygonFeature(geo: any): AoiFeature | null {
  if (!geo) return null;

  if (
    geo.type === "Feature" &&
    geo.geometry &&
    (geo.geometry.type === "Polygon" || geo.geometry.type === "MultiPolygon")
  ) {
    return geo as AoiFeature;
  }

  if (geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    for (const f of geo.features) {
      if (
        f?.geometry?.type === "Polygon" ||
        f?.geometry?.type === "MultiPolygon"
      ) {
        return f as AoiFeature;
      }
    }
  }

  return null;
}

function forEachCoordinate(
  coords: unknown,
  visit: (lng: number, lat: number) => void
): void {
  if (!Array.isArray(coords)) return;

  if (
    coords.length >= 2 &&
    typeof coords[0] === "number" &&
    typeof coords[1] === "number"
  ) {
    visit(coords[0], coords[1]);
    return;
  }

  for (const child of coords) {
    forEachCoordinate(child, visit);
  }
}

function hasAnyCoordinate(geometry: any): boolean {
  let found = false;

  forEachCoordinate(geometry?.coordinates, () => {
    found = true;
  });

  return found;
}

function assertCoordinatesLookLikeWgs84(aoi: AoiFeature): void {
  let hasCoordinate = false;
  let invalidCoordinate: { lng: number; lat: number } | null = null;

  forEachCoordinate(aoi.geometry?.coordinates, (lng, lat) => {
    hasCoordinate = true;

    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      lng < -180 ||
      lng > 180 ||
      lat < -90 ||
      lat > 90
    ) {
      invalidCoordinate = { lng, lat };
    }
  });

  if (!hasCoordinate) {
    throw new Error("AOI invalide : aucune coordonnée détectée.");
  }

  if (invalidCoordinate) {
    const { lng, lat } = invalidCoordinate;
    throw new Error(
      `AOI invalide : les coordonnées ne semblent pas être en WGS84 (longitude/latitude EPSG:4326). Coordonnée détectée hors plage : [${lng}, ${lat}].`
    );
  }
}

export function validateAoi(geo: any): AoiFeature {
  const aoi = firstPolygonFeature(geo);

  if (!aoi) {
    throw new Error(
      "AOI invalide : aucun polygone ou multipolygone détecté."
    );
  }

  if (!aoi.geometry?.coordinates || !hasAnyCoordinate(aoi.geometry)) {
    throw new Error("AOI invalide : géométrie vide.");
  }

  assertCoordinatesLookLikeWgs84(aoi);

  return aoi;
}
