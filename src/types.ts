import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from "geojson";

export type AoiFeature = Feature<Polygon | MultiPolygon>;
export type AnyFeature = Feature<Geometry, Record<string, any>>;

export type TileProps = {
  product: "lidar" | "mnt";

  tile_id?: string;
  NOM_TUILE?: string;

  TELECHARGEMENT_TUILE?: string;

  year?: number;
  provider?: string;

  [key: string]: any;
};

export type TileFeature = Feature<Polygon | MultiPolygon, TileProps>;
export type TileFC = FeatureCollection<Polygon | MultiPolygon, TileProps>;

export type GridChunk = {
  id: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] in EPSG:4326
  path: string;
};

export type GridIndex = {
  version: string;
  chunkSizeDeg: number;
  chunks: GridChunk[];
};

export type BasemapConfig = {
  basemaps: Array<{
    id: string;
    label: string;
    type: "raster";
    tiles: string[];
    tileSize?: number;
    attribution?: string;
  }>;
  overlays?: Array<
    | {
        id: string;
        label: string;
        type: "wms";
        url: string;
        layers: string;
        format?: string;
        transparent?: boolean;
      }
  >;
};
