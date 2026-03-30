export type ProductType = "lidar" | "mnt";

export type BBox = [number, number, number, number];

export type BasemapItem = {
  id?: string;
  name?: string;
  title?: string;
  label?: string;
  tiles: string[];
  tileSize?: number;
  attribution?: string;
};

export type BasemapConfig = {
  basemaps: BasemapItem[];
};

export type Geometry =
  | {
      type: "Polygon";
      coordinates: number[][][];
    }
  | {
      type: "MultiPolygon";
      coordinates: number[][][][];
    }
  | {
      type: "Point";
      coordinates: number[];
    };

export type TileProps = {
  product: ProductType;

  tile_id?: string;
  NOM_TUILE?: string;
  name?: string;

  url?: string;
  download_url?: string;
  TELECHARGEMENT_TUILE?: string;
  telechargement_tuile?: string;

  year?: number | string;
  provider?: string;
  PROJET?: string;
  FORMAT?: string;
  SOURCE_DONNEES?: string;

  __selected?: boolean;

  [key: string]: any;
};

export type AoiProps = {
  name?: string;
  id?: string;
  [key: string]: any;
};

export type FeatureOf<P = Record<string, any>> = {
  type: "Feature";
  properties: P;
  geometry: Geometry;
  id?: string | number;
};

export type FeatureCollectionOf<P = Record<string, any>> = {
  type: "FeatureCollection";
  features: FeatureOf<P>[];
};

export type TileFeature = FeatureOf<TileProps>;
export type TileFC = FeatureCollectionOf<TileProps>;

export type AoiFeature = FeatureOf<AoiProps>;
export type AoiFC = FeatureCollectionOf<AoiProps>;

export type ChunkIndexItem = {
  path: string;
  bbox: BBox;
};

export type GridIndex = {
  bbox: BBox;
  chunks: ChunkIndexItem[];
};