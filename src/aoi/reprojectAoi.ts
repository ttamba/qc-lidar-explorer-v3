import proj4 from "proj4";

type SupportedSourceCrs = {
  code: SupportedSourceCrsCode;
  label: string;
  proj4: string;
};

export type SupportedSourceCrsCode =
  | "EPSG:32188"
  | "EPSG:32189"
  | "EPSG:2945"
  | "EPSG:2946"
  | "EPSG:2947"
  | "EPSG:2948"
  | "EPSG:2949"
  | "EPSG:2950"
  | "EPSG:2951"
  | "EPSG:26918"
  | "EPSG:26919";

export const SUPPORTED_SOURCE_CRS: SupportedSourceCrs[] = [
  {
    code: "EPSG:32188",
    label: "NAD83 / MTM zone 8 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-73.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:32189",
    label: "NAD83 / MTM zone 9 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-76.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2945",
    label: "NAD83(CSRS) / MTM zone 3 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-58.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2946",
    label: "NAD83(CSRS) / MTM zone 4 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-61.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2947",
    label: "NAD83(CSRS) / MTM zone 5 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-64.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2948",
    label: "NAD83(CSRS) / MTM zone 6 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-67.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2949",
    label: "NAD83(CSRS) / MTM zone 7 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-70.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2950",
    label: "NAD83(CSRS) / MTM zone 8 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-73.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:2951",
    label: "NAD83(CSRS) / MTM zone 9 (Québec)",
    proj4:
      "+proj=tmerc +lat_0=0 +lon_0=-76.5 +k=0.9999 +x_0=304800 +y_0=0 +ellps=GRS80 +towgs84=-0.991,1.9072,0.5129,-1.25033e-07,-4.6785e-08,-5.6529e-08,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:26918",
    label: "NAD83 / UTM zone 18N",
    proj4:
      "+proj=utm +zone=18 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  },
  {
    code: "EPSG:26919",
    label: "NAD83 / UTM zone 19N",
    proj4:
      "+proj=utm +zone=19 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  },
];

const TARGET_CRS = "EPSG:4326";
let defsRegistered = false;

function ensureProjDefinitions(): void {
  if (defsRegistered) return;
  proj4.defs(TARGET_CRS, "+proj=longlat +datum=WGS84 +no_defs +type=crs");
  for (const crs of SUPPORTED_SOURCE_CRS) {
    proj4.defs(crs.code, crs.proj4);
  }
  defsRegistered = true;
}

function forEachCoordinate(coords: unknown, visit: (x: number, y: number) => void): void {
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

function getCoordinateSampleStats(geo: any) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let hasCoordinates = false;

  const visitGeometry = (geometry: any) => {
    if (!geometry) return;

    if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
      for (const child of geometry.geometries) visitGeometry(child);
      return;
    }

    forEachCoordinate(geometry.coordinates, (x, y) => {
      hasCoordinates = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  };

  if (geo?.type === "FeatureCollection" && Array.isArray(geo.features)) {
    for (const feature of geo.features) visitGeometry(feature?.geometry);
  } else if (geo?.type === "Feature") {
    visitGeometry(geo.geometry);
  } else if (geo?.type) {
    visitGeometry(geo);
  }

  return { minX, maxX, minY, maxY, hasCoordinates };
}

function looksLikeUtm(stats: { minX: number; maxX: number; minY: number; maxY: number }) {
  return (
    stats.minX >= 200000 &&
    stats.maxX <= 900000 &&
    stats.minY >= 4800000 &&
    stats.maxY <= 6500000
  );
}

function looksLikeMtmQuebec(stats: { minX: number; maxX: number; minY: number; maxY: number }) {
  return (
    stats.minX >= 100000 &&
    stats.maxX <= 700000 &&
    stats.minY >= 4800000 &&
    stats.maxY <= 6500000
  );
}

export function autoDetectSourceCrsFromGeoJson(geo: any): SupportedSourceCrsCode | null {
  const stats = getCoordinateSampleStats(geo);
  if (!stats.hasCoordinates) return null;

  if (
    stats.minX >= -180 &&
    stats.maxX <= 180 &&
    stats.minY >= -90 &&
    stats.maxY <= 90
  ) {
    return null;
  }

  if (looksLikeUtm(stats)) {
    const centerX = (stats.minX + stats.maxX) / 2;
    return centerX < 500000 ? "EPSG:26918" : "EPSG:26919";
  }

  if (looksLikeMtmQuebec(stats)) {
    const centerX = (stats.minX + stats.maxX) / 2;
    return centerX < 304800 ? "EPSG:32189" : "EPSG:32188";
  }

  return null;
}

function transformCoordinates(coords: unknown, sourceCrs: SupportedSourceCrsCode): unknown {
  if (!Array.isArray(coords)) return coords;

  if (
    coords.length >= 2 &&
    typeof coords[0] === "number" &&
    typeof coords[1] === "number"
  ) {
    const [lng, lat] = proj4(sourceCrs, TARGET_CRS, [coords[0], coords[1]]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error("La reprojection a produit une coordonnée invalide.");
    }
    if (coords.length > 2) return [lng, lat, ...coords.slice(2)];
    return [lng, lat];
  }

  return coords.map((child) => transformCoordinates(child, sourceCrs));
}

function reprojectGeometry<T extends { type: string; coordinates?: unknown; geometries?: any[] }>(
  geometry: T,
  sourceCrs: SupportedSourceCrsCode
): T {
  if (!geometry) return geometry;

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return {
      ...geometry,
      geometries: geometry.geometries.map((child) => reprojectGeometry(child, sourceCrs)),
    };
  }

  if (!("coordinates" in geometry)) return geometry;

  return {
    ...geometry,
    coordinates: transformCoordinates(geometry.coordinates, sourceCrs),
  };
}

function reprojectFeature(feature: any, sourceCrs: SupportedSourceCrsCode): any {
  if (!feature?.geometry) return feature;
  return { ...feature, geometry: reprojectGeometry(feature.geometry, sourceCrs) };
}

export function reprojectGeoJsonToWgs84(geo: any, sourceCrs: SupportedSourceCrsCode): any {
  ensureProjDefinitions();

  if (!geo) throw new Error("Aucune donnée AOI à reprojeter.");

  if (geo.type === "FeatureCollection" && Array.isArray(geo.features)) {
    return {
      ...geo,
      features: geo.features.map((feature: any) => reprojectFeature(feature, sourceCrs)),
    };
  }

  if (geo.type === "Feature") return reprojectFeature(geo, sourceCrs);
  if (geo.type && geo.coordinates) return reprojectGeometry(geo, sourceCrs);

  throw new Error("Format GeoJSON non supporté pour la reprojection.");
}
