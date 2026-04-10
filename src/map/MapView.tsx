import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { LngLatBoundsLike, Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type {
  AoiFeature,
  BasemapConfig,
  FeatureCollectionOf,
  Geometry,
  TileFeature,
  TileProps,
} from "../types";
import { loadTilesForBBox } from "../index/loadChunks";
import { intersectAoiWithTiles } from "../selection/intersect";
import { extractAvailableYears, filterTilesByYear } from "../utils/filterTiles";
import { normalizeTile } from "../utils/normalizeTile";

type Dataset = "lidar" | "mnt";

type Props = {
  basemaps: BasemapConfig | null;
  aoi: AoiFeature | null;
  selectedProduct: Dataset;
  yearFilter: {
    lidar: string | "ALL";
    mnt: string | "ALL";
  };
  onYearsChange?: (years: { lidar: string[]; mnt: string[] }) => void;
  onSelectionChange: (tiles: TileFeature[]) => void;
};

type LabelProps = {
  label_text: string;
  normalized_id?: string;
  normalized_product?: string;
  normalized_url?: string;
  __dataset: Dataset;
};

type LabelFeature = {
  type: "Feature";
  properties: LabelProps;
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
};

type LabelFC = FeatureCollectionOf<LabelProps>;

type HoverProps = {
  __hover: true;
};

type HoverFC = FeatureCollectionOf<HoverProps>;

type PanelInfo = {
  id: string;
  name: string;
  product: "lidar" | "mnt" | "";
  url: string;
  year?: string;
  provider?: string;
  raw: TileFeature;
};

type RuntimeTileFeature = TileFeature & {
  id: string;
  properties: TileProps & {
    __dataset: Dataset;
    normalized_id: string;
    normalized_product: "lidar" | "mnt";
    normalized_url: string;
    normalized_name: string;
    normalized_year?: string;
    normalized_provider?: string;
  };
};

const SRC_LIDAR = "lidar-src";
const SRC_MNT = "mnt-src";
const SRC_LIDAR_LABELS = "lidar-labels-src";
const SRC_MNT_LABELS = "mnt-labels-src";
const SRC_LIDAR_SELECTED = "lidar-selected-src";
const SRC_MNT_SELECTED = "mnt-selected-src";
const SRC_AOI = "aoi-src";
const SRC_HOVER = "hover-src";

const LYR_LIDAR = "lidar-lyr";
const LYR_LIDAR_OUTLINE = "lidar-lyr-outline";
const LYR_LIDAR_SELECTED = "lidar-selected-lyr";
const LYR_LIDAR_SELECTED_FILL = "lidar-selected-fill-lyr";
const LYR_LIDAR_SELECTED_OUTLINE = "lidar-selected-outline-lyr";
const LYR_LIDAR_LABELS = "lidar-labels-lyr";

const LYR_MNT = "mnt-lyr";
const LYR_MNT_OUTLINE = "mnt-lyr-outline";
const LYR_MNT_SELECTED = "mnt-selected-lyr";
const LYR_MNT_SELECTED_FILL = "mnt-selected-fill-lyr";
const LYR_MNT_SELECTED_OUTLINE = "mnt-selected-outline-lyr";
const LYR_MNT_LABELS = "mnt-labels-lyr";

const LYR_AOI = "aoi-lyr";
const LYR_AOI_FILL = "aoi-fill-lyr";
const LYR_HOVER_FILL = "hover-fill-lyr";
const LYR_HOVER_OUTLINE = "hover-outline-lyr";

const EMPTY_TILE_FC: FeatureCollectionOf<TileProps> = {
  type: "FeatureCollection",
  features: [],
};

const EMPTY_LABEL_FC: LabelFC = {
  type: "FeatureCollection",
  features: [],
};

const EMPTY_AOI_FC: FeatureCollectionOf<Record<string, any>> = {
  type: "FeatureCollection",
  features: [],
};

const EMPTY_HOVER_FC: HoverFC = {
  type: "FeatureCollection",
  features: [],
};

const MIN_ZOOM_FOR_LIDAR_LOAD = 10;
const MIN_ZOOM_FOR_MNT_LOAD = 9;
const QUEBEC_BOUNDS: LngLatBoundsLike = [
  [-79.8, 44.5],
  [-57.0, 62.2],
];

function rafThrottle<T extends (...args: any[]) => void>(fn: T): T {
  let scheduled = false;
  let lastArgs: any[] = [];

  return ((...args: any[]) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  }) as T;
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

function getGeoJsonSource(map: Map, sourceId: string) {
  return map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
}

function getSelectionLayerIds(dataset: Dataset) {
  return dataset === "lidar"
    ? [
        LYR_LIDAR,
        LYR_LIDAR_OUTLINE,
        LYR_LIDAR_SELECTED,
        LYR_LIDAR_SELECTED_FILL,
        LYR_LIDAR_SELECTED_OUTLINE,
        LYR_LIDAR_LABELS,
      ]
    : [
        LYR_MNT,
        LYR_MNT_OUTLINE,
        LYR_MNT_SELECTED,
        LYR_MNT_SELECTED_FILL,
        LYR_MNT_SELECTED_OUTLINE,
        LYR_MNT_LABELS,
      ];
}

function buildRuntimeKey(dataset: Dataset, normalizedId: string) {
  return `${dataset}::${normalizedId}`;
}

function buildAoiKey(aoi: AoiFeature | null) {
  return aoi ? JSON.stringify(aoi.geometry) : "aoi::empty";
}

function buildFeatureSignature(
  features: Array<{ id?: string; properties?: { normalized_id?: string } }>
) {
  if (features.length === 0) return "0";
  const first = features[0];
  const last = features[features.length - 1];
  return `${features.length}:${first.id ?? first.properties?.normalized_id ?? ""}:${last.id ?? last.properties?.normalized_id ?? ""}`;
}

function areSetsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function getGeometryBounds(geometry: Geometry): [number, number, number, number] | null {
  if (!geometry || !(geometry as any).coordinates) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      const x = coords[0];
      const y = coords[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }

    for (const child of coords) {
      visit(child);
    }
  };

  visit((geometry as any).coordinates);

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

function getAoiBounds(aoi: AoiFeature | null): LngLatBoundsLike | null {
  if (!aoi?.geometry) return null;
  const bounds = getGeometryBounds(aoi.geometry);
  if (!bounds) return null;
  const [minX, minY, maxX, maxY] = bounds;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map());
  const normalizeCacheRef = useRef(new WeakMap<TileFeature, ReturnType<typeof normalizeTile>>());
  const centerCacheRef = useRef<globalThis.Map<string, [number, number] | null>>(new globalThis.Map());
  const labelCacheRef = useRef<globalThis.Map<string, LabelFeature[]>>(new globalThis.Map());
  const sourceDataKeyRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());

  const aoiIntersectCacheRef = useRef<{
    lidar: globalThis.Map<string, TileFeature[]>;
    mnt: globalThis.Map<string, TileFeature[]>;
  }>({
    lidar: new globalThis.Map(),
    mnt: new globalThis.Map(),
  });

  const requestSeqRef = useRef(0);
  const selectionSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const hoverKeyRef = useRef<string>("");
  const lastFittedAoiKeyRef = useRef<string>("");
  const hasInitialLoadCompletedRef = useRef(false);
  const lastRefreshKeyRef = useRef<string>("");
  const lastAppliedStyleKeyRef = useRef<string>("");
  const pendingRefreshOptionsRef = useRef<{ reloadData: boolean; reason: string } | null>(null);

  const selectedProductRef = useRef(props.selectedProduct);
  const aoiRef = useRef(props.aoi);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const onYearsChangeRef = useRef(props.onYearsChange);
  const yearFilterRef = useRef(props.yearFilter);

  const rawLidarTilesRef = useRef<TileFeature[]>([]);
  const rawMntTilesRef = useRef<TileFeature[]>([]);
  const displayedLidarTilesRef = useRef<RuntimeTileFeature[]>([]);
  const displayedMntTilesRef = useRef<RuntimeTileFeature[]>([]);

  const lookupByRuntimeIdRef = useRef<{
    lidar: globalThis.Map<string, RuntimeTileFeature>;
    mnt: globalThis.Map<string, RuntimeTileFeature>;
  }>({
    lidar: new globalThis.Map(),
    mnt: new globalThis.Map(),
  });

  const lookupByNormalizedIdRef = useRef<{
    lidar: globalThis.Map<string, RuntimeTileFeature>;
    mnt: globalThis.Map<string, RuntimeTileFeature>;
  }>({
    lidar: new globalThis.Map(),
    mnt: new globalThis.Map(),
  });

  const selectedKeysRef = useRef<{ lidar: Set<string>; mnt: Set<string> }>({
    lidar: new Set<string>(),
    mnt: new Set<string>(),
  });

  const lastViewStateRef = useRef<{
    bboxKey: string;
    activeDataset: Dataset | "";
  }>({
    bboxKey: "",
    activeDataset: "",
  });

  const [panelInfo, setPanelInfo] = useState<PanelInfo | null>(null);
  const panelInfoRef = useRef<PanelInfo | null>(null);
  const [mapZoom, setMapZoom] = useState<number>(8);

  useEffect(() => {
    selectedProductRef.current = props.selectedProduct;
  }, [props.selectedProduct]);

  useEffect(() => {
    aoiRef.current = props.aoi;
  }, [props.aoi]);

  useEffect(() => {
    onSelectionChangeRef.current = props.onSelectionChange;
  }, [props.onSelectionChange]);

  useEffect(() => {
    onYearsChangeRef.current = props.onYearsChange;
  }, [props.onYearsChange]);

  useEffect(() => {
    yearFilterRef.current = props.yearFilter;
  }, [props.yearFilter]);

  useEffect(() => {
    panelInfoRef.current = panelInfo;
  }, [panelInfo]);

  const styleSpec = useMemo<maplibregl.StyleSpecification>(() => {
    const osm = props.basemaps?.basemaps?.[0];
    const tiles = osm?.tiles ?? ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"];
    const tileSize = osm?.tileSize ?? 256;
    const attribution = osm?.attribution ?? "© OpenStreetMap contributors";

    return {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles,
          tileSize,
          attribution,
        },
      },
      layers: [
        {
          id: "osm",
          type: "raster",
          source: "osm",
        },
      ],
    };
  }, [props.basemaps]);

  const styleSpecKey = useMemo(() => JSON.stringify(styleSpec), [styleSpec]);

  const showLidarZoomHint = props.selectedProduct === "lidar" && mapZoom < MIN_ZOOM_FOR_LIDAR_LOAD;
  const showMntZoomHint = props.selectedProduct === "mnt" && mapZoom < MIN_ZOOM_FOR_MNT_LOAD;

  function getNormalized(tile: TileFeature) {
    const cached = normalizeCacheRef.current.get(tile);
    if (cached) return cached;
    const normalized = normalizeTile(tile);
    normalizeCacheRef.current.set(tile, normalized);
    return normalized;
  }

  function getTileArraySignature(tiles: TileFeature[]) {
    if (tiles.length === 0) return "0";
    const first = getNormalized(tiles[0]).id;
    const last = getNormalized(tiles[tiles.length - 1]).id;
    return `${tiles.length}:${first}:${last}`;
  }

  function buildAoiIntersectCacheKey(
    dataset: Dataset,
    bboxKey: string,
    aoiKey: string,
    tiles: TileFeature[]
  ) {
    return `${dataset}|${bboxKey}|${aoiKey}|${getTileArraySignature(tiles)}`;
  }

  function clearAoiIntersectCache(dataset?: Dataset) {
    if (!dataset) {
      aoiIntersectCacheRef.current.lidar.clear();
      aoiIntersectCacheRef.current.mnt.clear();
      return;
    }
    aoiIntersectCacheRef.current[dataset].clear();
  }

  function getAoiFilteredTiles(
    dataset: Dataset,
    bboxKey: string,
    aoi: AoiFeature | null,
    tiles: TileFeature[]
  ): TileFeature[] {
    if (!aoi || tiles.length === 0) return tiles;

    const aoiKey = buildAoiKey(aoi);
    const cacheKey = buildAoiIntersectCacheKey(dataset, bboxKey, aoiKey, tiles);
    const cache = aoiIntersectCacheRef.current[dataset];
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = intersectAoiWithTiles(aoi, tiles);
    cache.set(cacheKey, result);

    if (cache.size > 12) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    return result;
  }

  function setRuntimeTiles(dataset: Dataset, tiles: RuntimeTileFeature[]) {
    if (dataset === "lidar") {
      displayedLidarTilesRef.current = tiles;
    } else {
      displayedMntTilesRef.current = tiles;
    }

    const byRuntime = new globalThis.Map<string, RuntimeTileFeature>();
    const byNormalized = new globalThis.Map<string, RuntimeTileFeature>();

    for (const tile of tiles) {
      byRuntime.set(tile.id, tile);
      byNormalized.set(tile.properties.normalized_id, tile);
    }

    lookupByRuntimeIdRef.current[dataset] = byRuntime;
    lookupByNormalizedIdRef.current[dataset] = byNormalized;
  }

  function setSourceDataIfChanged(map: Map, sourceId: string, key: string, data: unknown) {
    const source = getGeoJsonSource(map, sourceId);
    if (!source) return;
    const previousKey = sourceDataKeyRef.current.get(sourceId);
    if (previousKey === key) return;
    sourceDataKeyRef.current.set(sourceId, key);
    source.setData(data as any);
  }

  function setSelectedSourceData(map: Map, sourceId: string, features: RuntimeTileFeature[]) {
    const key = `${sourceId}::${buildFeatureSignature(features)}`;
    const fc: FeatureCollectionOf<TileProps> = { type: "FeatureCollection", features };
    setSourceDataIfChanged(map, sourceId, key, fc);
  }

  function ensureCustomSourcesAndLayers(map: Map) {
    if (!map.getSource(SRC_LIDAR)) map.addSource(SRC_LIDAR, { type: "geojson", data: EMPTY_TILE_FC as any });
    if (!map.getSource(SRC_MNT)) map.addSource(SRC_MNT, { type: "geojson", data: EMPTY_TILE_FC as any });
    if (!map.getSource(SRC_LIDAR_SELECTED)) map.addSource(SRC_LIDAR_SELECTED, { type: "geojson", data: EMPTY_TILE_FC as any });
    if (!map.getSource(SRC_MNT_SELECTED)) map.addSource(SRC_MNT_SELECTED, { type: "geojson", data: EMPTY_TILE_FC as any });
    if (!map.getSource(SRC_LIDAR_LABELS)) map.addSource(SRC_LIDAR_LABELS, { type: "geojson", data: EMPTY_LABEL_FC as any });
    if (!map.getSource(SRC_MNT_LABELS)) map.addSource(SRC_MNT_LABELS, { type: "geojson", data: EMPTY_LABEL_FC as any });
    if (!map.getSource(SRC_AOI)) map.addSource(SRC_AOI, { type: "geojson", data: EMPTY_AOI_FC as any });
    if (!map.getSource(SRC_HOVER)) map.addSource(SRC_HOVER, { type: "geojson", data: EMPTY_HOVER_FC as any });

    if (!map.getLayer(LYR_LIDAR)) map.addLayer({ id: LYR_LIDAR, type: "fill", source: SRC_LIDAR, paint: { "fill-color": "#2563eb", "fill-opacity": 0.22 } });
    if (!map.getLayer(LYR_LIDAR_OUTLINE)) map.addLayer({ id: LYR_LIDAR_OUTLINE, type: "line", source: SRC_LIDAR, paint: { "line-color": "#1d4ed8", "line-width": 2, "line-opacity": 0.95 } });
    if (!map.getLayer(LYR_LIDAR_SELECTED)) map.addLayer({ id: LYR_LIDAR_SELECTED, type: "fill", source: SRC_LIDAR, paint: { "fill-color": "#00ffff", "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.45, 0] } });
    if (!map.getLayer(LYR_LIDAR_SELECTED_FILL)) map.addLayer({ id: LYR_LIDAR_SELECTED_FILL, type: "fill", source: SRC_LIDAR_SELECTED, paint: { "fill-color": "#22c55e", "fill-opacity": 0.28 } });
    if (!map.getLayer(LYR_LIDAR_SELECTED_OUTLINE)) map.addLayer({ id: LYR_LIDAR_SELECTED_OUTLINE, type: "line", source: SRC_LIDAR_SELECTED, paint: { "line-color": "#16a34a", "line-width": 3, "line-opacity": 1 } });
    if (!map.getLayer(LYR_LIDAR_LABELS)) map.addLayer({ id: LYR_LIDAR_LABELS, type: "symbol", source: SRC_LIDAR_LABELS, minzoom: 11, layout: { "text-field": ["coalesce", ["get", "label_text"], ""], "text-size": 11, "text-anchor": "center", "text-allow-overlap": false, "text-ignore-placement": false }, paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } });

    if (!map.getLayer(LYR_MNT)) map.addLayer({ id: LYR_MNT, type: "fill", source: SRC_MNT, paint: { "fill-color": "#16a34a", "fill-opacity": 0.22 } });
    if (!map.getLayer(LYR_MNT_OUTLINE)) map.addLayer({ id: LYR_MNT_OUTLINE, type: "line", source: SRC_MNT, paint: { "line-color": "#15803d", "line-width": 2, "line-opacity": 0.95 } });
    if (!map.getLayer(LYR_MNT_SELECTED)) map.addLayer({ id: LYR_MNT_SELECTED, type: "fill", source: SRC_MNT, paint: { "fill-color": "#00ffff", "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.45, 0] } });
    if (!map.getLayer(LYR_MNT_SELECTED_FILL)) map.addLayer({ id: LYR_MNT_SELECTED_FILL, type: "fill", source: SRC_MNT_SELECTED, paint: { "fill-color": "#f59e0b", "fill-opacity": 0.28 } });
    if (!map.getLayer(LYR_MNT_SELECTED_OUTLINE)) map.addLayer({ id: LYR_MNT_SELECTED_OUTLINE, type: "line", source: SRC_MNT_SELECTED, paint: { "line-color": "#d97706", "line-width": 3, "line-opacity": 1 } });
    if (!map.getLayer(LYR_MNT_LABELS)) map.addLayer({ id: LYR_MNT_LABELS, type: "symbol", source: SRC_MNT_LABELS, minzoom: 11, layout: { "text-field": ["coalesce", ["get", "label_text"], ""], "text-size": 11, "text-anchor": "center", "text-allow-overlap": false, "text-ignore-placement": false }, paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } });

    if (!map.getLayer(LYR_AOI_FILL)) map.addLayer({ id: LYR_AOI_FILL, type: "fill", source: SRC_AOI, paint: { "fill-color": "#dc2626", "fill-opacity": 0.14 } });
    if (!map.getLayer(LYR_AOI)) map.addLayer({ id: LYR_AOI, type: "line", source: SRC_AOI, paint: { "line-color": "#dc2626", "line-width": 3, "line-opacity": 1 } });
    if (!map.getLayer(LYR_HOVER_FILL)) map.addLayer({ id: LYR_HOVER_FILL, type: "fill", source: SRC_HOVER, paint: { "fill-color": "#f59e0b", "fill-opacity": 0.18 } });
    if (!map.getLayer(LYR_HOVER_OUTLINE)) map.addLayer({ id: LYR_HOVER_OUTLINE, type: "line", source: SRC_HOVER, paint: { "line-color": "#f59e0b", "line-width": 3, "line-opacity": 1 } });
  }

  function setDatasetVisibility(map: Map, dataset: Dataset, visible: boolean) {
    const visibility = visible ? "visible" : "none";
    for (const id of getSelectionLayerIds(dataset)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  }

  function computeGeometryCenter(runtimeKey: string, geometry: Geometry): [number, number] | null {
    const cached = centerCacheRef.current.get(runtimeKey);
    if (cached !== undefined) return cached;
    const bounds = getGeometryBounds(geometry);
    if (!bounds) {
      centerCacheRef.current.set(runtimeKey, null);
      return null;
    }
    const center: [number, number] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    centerCacheRef.current.set(runtimeKey, center);
    return center;
  }

  function toRuntimeTiles(rawTiles: TileFeature[], dataset: Dataset): RuntimeTileFeature[] {
    return rawTiles.map((tile) => {
      const normalized = getNormalized(tile);
      const normalizedId = normalized.id;
      const normalizedProduct = normalized.product === "lidar" || normalized.product === "mnt" ? normalized.product : dataset;
      const runtimeKey = buildRuntimeKey(dataset, normalizedId);

      return {
        ...tile,
        id: runtimeKey,
        properties: {
          ...tile.properties,
          __dataset: dataset,
          normalized_id: normalizedId,
          normalized_product: normalizedProduct,
          normalized_url: normalized.url,
          normalized_name: normalized.name,
          normalized_year: normalized.year,
          normalized_provider:
            normalized.provider ?? tile.properties?.provider ?? tile.properties?.SOURCE_DONNEES ?? tile.properties?.PROJET
              ? String(normalized.provider ?? tile.properties?.provider ?? tile.properties?.SOURCE_DONNEES ?? tile.properties?.PROJET)
              : undefined,
        },
      };
    });
  }

  function setTileSourceData(map: Map, sourceId: string, features: RuntimeTileFeature[]) {
    const key = `${sourceId}::${buildFeatureSignature(features)}`;
    const fc: FeatureCollectionOf<TileProps> = { type: "FeatureCollection", features };
    setSourceDataIfChanged(map, sourceId, key, fc);
  }

  function setLabelSourceData(map: Map, sourceId: string, features: LabelFeature[]) {
    const key = `${sourceId}::${features.length}:${features[0]?.properties.normalized_id ?? ""}:${features[features.length - 1]?.properties.normalized_id ?? ""}`;
    const fc: LabelFC = { type: "FeatureCollection", features };
    setSourceDataIfChanged(map, sourceId, key, fc);
  }

  function setAoiSourceData(map: Map, aoi: AoiFeature | null) {
    const data = aoi ? { type: "FeatureCollection", features: [aoi] } : EMPTY_AOI_FC;
    const key = aoi ? `aoi::${JSON.stringify(aoi.geometry)}` : "aoi::empty";
    setSourceDataIfChanged(map, SRC_AOI, key, data);
  }

  function setHoverSourceData(map: Map, tile: RuntimeTileFeature | null) {
    if (!tile) {
      setSourceDataIfChanged(map, SRC_HOVER, "hover::empty", EMPTY_HOVER_FC);
      return;
    }
    const fc: HoverFC = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { __hover: true }, geometry: tile.geometry }],
    };
    setSourceDataIfChanged(map, SRC_HOVER, `hover::${tile.id}`, fc);
  }

  function updateLabelSource(map: Map, dataset: Dataset, features: RuntimeTileFeature[]) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR_LABELS : SRC_MNT_LABELS;
    const cacheKey = `${dataset}::${buildFeatureSignature(features)}`;
    const cached = labelCacheRef.current.get(cacheKey);
    if (cached) {
      setLabelSourceData(map, sourceId, cached);
      return;
    }

    const pointFeatures: LabelFeature[] = [];
    for (const feature of features) {
      const center = computeGeometryCenter(feature.id, feature.geometry);
      if (!center) continue;
      pointFeatures.push({
        type: "Feature",
        properties: {
          __dataset: dataset,
          label_text: feature.properties.normalized_name ?? "",
          normalized_id: feature.properties.normalized_id,
          normalized_product: feature.properties.normalized_product,
          normalized_url: feature.properties.normalized_url,
        },
        geometry: { type: "Point", coordinates: center },
      });
    }

    labelCacheRef.current.set(cacheKey, pointFeatures);
    setLabelSourceData(map, sourceId, pointFeatures);
  }

  function setTilesOnMap(map: Map, dataset: Dataset, rawTiles: TileFeature[]) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;
    const runtimeTiles = toRuntimeTiles(rawTiles, dataset);
    setRuntimeTiles(dataset, runtimeTiles);
    setTileSourceData(map, sourceId, runtimeTiles);

    if (map.getZoom() >= 11) {
      updateLabelSource(map, dataset, runtimeTiles);
    } else {
      setLabelSourceData(map, dataset === "lidar" ? SRC_LIDAR_LABELS : SRC_MNT_LABELS, []);
    }
  }

  function clearSelectionState(map: Map, dataset: Dataset) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;
    const previous = selectedKeysRef.current[dataset];
    for (const id of previous) {
      try {
        map.setFeatureState({ source: sourceId, id }, { selected: false });
      } catch {
        // ignore
      }
    }
    selectedKeysRef.current[dataset] = new Set<string>();
  }

  function clearSelectionImmediately(map: Map) {
    selectionSeqRef.current += 1;
    requestSeqRef.current += 1;
    clearSelectionState(map, "lidar");
    clearSelectionState(map, "mnt");
    sourceDataKeyRef.current.delete(SRC_LIDAR_SELECTED);
    sourceDataKeyRef.current.delete(SRC_MNT_SELECTED);
    setSelectedSourceData(map, SRC_LIDAR_SELECTED, []);
    setSelectedSourceData(map, SRC_MNT_SELECTED, []);
    onSelectionChangeRef.current([]);
    clearHover(map);
  }

  function applySelectionState(map: Map, dataset: Dataset, nextSelected: Set<string>, forceReapply = false) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;
    const previous = selectedKeysRef.current[dataset];
    if (!forceReapply && areSetsEqual(previous, nextSelected)) return;

    for (const id of previous) {
      if (forceReapply || !nextSelected.has(id)) {
        try {
          map.setFeatureState({ source: sourceId, id }, { selected: false });
        } catch {
          // ignore
        }
      }
    }

    for (const id of nextSelected) {
      if (forceReapply || !previous.has(id)) {
        try {
          map.setFeatureState({ source: sourceId, id }, { selected: true });
        } catch {
          // ignore
        }
      }
    }

    selectedKeysRef.current[dataset] = new Set(nextSelected);
  }

  function applySelectionFromDisplayedTiles(
    map: Map,
    lidarTiles: RuntimeTileFeature[],
    mntTiles: RuntimeTileFeature[]
  ) {
    const selectedLidarIds = new Set<string>(lidarTiles.map((tile) => tile.id));
    const selectedMntIds = new Set<string>(mntTiles.map((tile) => tile.id));

    applySelectionState(map, "lidar", selectedLidarIds, false);
    applySelectionState(map, "mnt", selectedMntIds, false);

    setSelectedSourceData(map, SRC_LIDAR_SELECTED, lidarTiles);
    setSelectedSourceData(map, SRC_MNT_SELECTED, mntTiles);
    onSelectionChangeRef.current([...lidarTiles, ...mntTiles]);
  }

  function findTileByNormalizedId(dataset: Dataset, normalizedId: string): RuntimeTileFeature | null {
    return lookupByNormalizedIdRef.current[dataset].get(normalizedId) ?? null;
  }

  function getTileFromRenderedFeature(feature: unknown): RuntimeTileFeature | null {
    const rendered = feature as { properties?: Record<string, unknown>; id?: string | number };
    if (typeof rendered?.id === "string") {
      const runtimeId = rendered.id;
      const dataset = runtimeId.startsWith("lidar::") ? "lidar" : runtimeId.startsWith("mnt::") ? "mnt" : null;
      if (dataset) return lookupByRuntimeIdRef.current[dataset].get(runtimeId) ?? null;
    }

    const props = rendered?.properties ?? {};
    const normalizedId = typeof props.normalized_id === "string" ? props.normalized_id : "";
    const dataset =
      props.normalized_product === "lidar" || props.__dataset === "lidar"
        ? "lidar"
        : props.normalized_product === "mnt" || props.__dataset === "mnt"
          ? "mnt"
          : null;
    if (normalizedId && dataset) return findTileByNormalizedId(dataset, normalizedId);
    return null;
  }

  function getPanelInfoFromTile(tile: RuntimeTileFeature): PanelInfo {
    return {
      id: tile.properties.normalized_id,
      name: tile.properties.normalized_name,
      product: tile.properties.normalized_product,
      url: tile.properties.normalized_url,
      year: tile.properties.normalized_year,
      provider: tile.properties.normalized_provider,
      raw: tile,
    };
  }

  function syncPanelInfo() {
    const currentPanel = panelInfoRef.current;
    if (!currentPanel) return;
    const dataset = currentPanel.product === "lidar" || currentPanel.product === "mnt" ? currentPanel.product : null;
    if (!dataset) {
      setPanelInfo(null);
      return;
    }
    const freshTile = findTileByNormalizedId(dataset, currentPanel.id);
    if (freshTile) setPanelInfo(getPanelInfoFromTile(freshTile));
    else setPanelInfo(null);
  }

  function openUrl(url: string) {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function getInteractiveFeaturesAtPoint(map: Map, point: maplibregl.PointLike) {
    return map.queryRenderedFeatures(point, {
      layers: [
        LYR_LIDAR,
        LYR_LIDAR_OUTLINE,
        LYR_LIDAR_SELECTED,
        LYR_LIDAR_SELECTED_FILL,
        LYR_LIDAR_SELECTED_OUTLINE,
        LYR_LIDAR_LABELS,
        LYR_MNT,
        LYR_MNT_OUTLINE,
        LYR_MNT_SELECTED,
        LYR_MNT_SELECTED_FILL,
        LYR_MNT_SELECTED_OUTLINE,
        LYR_MNT_LABELS,
      ],
    });
  }

  function clearHover(map: Map) {
    if (hoverKeyRef.current) {
      hoverKeyRef.current = "";
      setHoverSourceData(map, null);
    }
  }

  function fitMapToAoi(map: Map, aoi: AoiFeature | null) {
    if (!aoi) return;
    const aoiKey = JSON.stringify(aoi.geometry);
    if (lastFittedAoiKeyRef.current === aoiKey) return;
    const bounds = getAoiBounds(aoi);
    if (!bounds) return;
    lastFittedAoiKeyRef.current = aoiKey;
    map.fitBounds(bounds, {
      padding: { top: 60, right: 60, bottom: 60, left: 60 },
      duration: 700,
      maxZoom: 15,
    });
  }

  async function refreshTiles(map: Map, options?: { reloadData?: boolean }) {
    perfMark("refreshTiles:start");
    if (!map.isStyleLoaded()) return;
    ensureCustomSourcesAndLayers(map);

    const requestId = ++requestSeqRef.current;
    const reloadData = options?.reloadData ?? false;
    const zoom = map.getZoom();

    const activeDataset = selectedProductRef.current;
    const showLidar = activeDataset === "lidar" && zoom >= MIN_ZOOM_FOR_LIDAR_LOAD;
    const showMnt = activeDataset === "mnt" && zoom >= MIN_ZOOM_FOR_MNT_LOAD;

    setDatasetVisibility(map, "lidar", showLidar);
    setDatasetVisibility(map, "mnt", showMnt);

    if (!showLidar && !showMnt) {
      rawLidarTilesRef.current = [];
      rawMntTilesRef.current = [];
      clearAoiIntersectCache();
      setRuntimeTiles("lidar", []);
      setRuntimeTiles("mnt", []);
      setTileSourceData(map, SRC_LIDAR, []);
      setTileSourceData(map, SRC_MNT, []);
      setSelectedSourceData(map, SRC_LIDAR_SELECTED, []);
      setSelectedSourceData(map, SRC_MNT_SELECTED, []);
      setLabelSourceData(map, SRC_LIDAR_LABELS, []);
      setLabelSourceData(map, SRC_MNT_LABELS, []);
      clearSelectionState(map, "lidar");
      clearSelectionState(map, "mnt");
      clearHover(map);
      onYearsChangeRef.current?.({ lidar: [], mnt: [] });
      onSelectionChangeRef.current([]);
      setPanelInfo(null);
      lastViewStateRef.current = { bboxKey: "", activeDataset: "" };
      lastRefreshKeyRef.current = "";
      perfMark("refreshTiles:end");
      perfMeasure("refreshTiles:total", "refreshTiles:start", "refreshTiles:end");
      return;
    }

    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];
    const bboxKey = bbox.map((n) => n.toFixed(5)).join(",");
    const aoi = aoiRef.current;
    const aoiKey = buildAoiKey(aoi);
    const activeYear =
      activeDataset === "lidar"
        ? yearFilterRef.current.lidar
        : yearFilterRef.current.mnt;
    const refreshKey = [bboxKey, activeDataset, activeYear, aoiKey].join("|");

    if (!reloadData && refreshKey === lastRefreshKeyRef.current) {
      perfMark("refreshTiles:end");
      perfMeasure("refreshTiles:total", "refreshTiles:start", "refreshTiles:end");
      return;
    }

    const mustReload =
      reloadData ||
      bboxKey !== lastViewStateRef.current.bboxKey ||
      activeDataset !== lastViewStateRef.current.activeDataset;

    let lidarRaw = rawLidarTilesRef.current;
    let mntRaw = rawMntTilesRef.current;

    if (mustReload) {
      if (showLidar) {
        lidarRaw = await loadTilesForBBox("lidar", bbox, cacheRef.current);
        if (requestId !== requestSeqRef.current) return;
        mntRaw = [];
        clearAoiIntersectCache("lidar");
      } else if (showMnt) {
        mntRaw = await loadTilesForBBox("mnt", bbox, cacheRef.current);
        if (requestId !== requestSeqRef.current) return;
        lidarRaw = [];
        clearAoiIntersectCache("mnt");
      }

      rawLidarTilesRef.current = lidarRaw;
      rawMntTilesRef.current = mntRaw;
      lastViewStateRef.current = { bboxKey, activeDataset };
    }

    const lidarAoiTiles = showLidar
      ? getAoiFilteredTiles("lidar", bboxKey, aoi, lidarRaw)
      : [];

    const mntAoiTiles = showMnt
      ? getAoiFilteredTiles("mnt", bboxKey, aoi, mntRaw)
      : [];

    onYearsChangeRef.current?.({
      lidar: extractAvailableYears(lidarAoiTiles),
      mnt: extractAvailableYears(mntAoiTiles),
    });

    const lidarDisplayTiles = showLidar
      ? filterTilesByYear(lidarAoiTiles, yearFilterRef.current.lidar)
      : [];

    const mntDisplayTiles = showMnt
      ? filterTilesByYear(mntAoiTiles, yearFilterRef.current.mnt)
      : [];

    setTilesOnMap(map, "lidar", lidarDisplayTiles);
    setTilesOnMap(map, "mnt", mntDisplayTiles);
    clearHover(map);
    syncPanelInfo();

    const lidarRuntime = displayedLidarTilesRef.current;
    const mntRuntime = displayedMntTilesRef.current;

    if (aoi) {
      applySelectionFromDisplayedTiles(map, lidarRuntime, mntRuntime);
    } else {
      applySelectionState(map, "lidar", new Set<string>(), false);
      applySelectionState(map, "mnt", new Set<string>(), false);
      setSelectedSourceData(map, SRC_LIDAR_SELECTED, []);
      setSelectedSourceData(map, SRC_MNT_SELECTED, []);
      onSelectionChangeRef.current([]);
    }

    lastRefreshKeyRef.current = refreshKey;
    perfMark("refreshTiles:end");
    perfMeasure("refreshTiles:total", "refreshTiles:start", "refreshTiles:end");
  }

  function scheduleRefresh(map: Map, options?: { delay?: number; reloadData?: boolean; reason?: string }) {
    const delay = options?.delay ?? 80;
    const reloadData = options?.reloadData ?? false;
    const reason = options?.reason ?? "unspecified";

    if (import.meta.env.DEV) {
      console.log("[perf] scheduleRefresh", { delay, reloadData, reason });
    }

    const pending = pendingRefreshOptionsRef.current;
    pendingRefreshOptionsRef.current = {
      reloadData: pending ? pending.reloadData || reloadData : reloadData,
      reason,
    };

    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      const nextOptions = pendingRefreshOptionsRef.current ?? { reloadData: false, reason: "timeout" };
      pendingRefreshOptionsRef.current = null;
      void refreshTiles(map, { reloadData: nextOptions.reloadData });
    }, delay);
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleSpec,
      bounds: QUEBEC_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      maxBounds: [[-82, 43.5], [-55, 63.5]],
    });

    lastAppliedStyleKeyRef.current = styleSpecKey;
    setMapZoom(map.getZoom());
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      const feature = getInteractiveFeaturesAtPoint(map, e.point)[0];
      if (!feature) return;
      const tile = getTileFromRenderedFeature(feature);
      if (!tile) return;
      const info = getPanelInfoFromTile(tile);
      setPanelInfo(info);
      const isDirectDownload = (e.originalEvent as MouseEvent).ctrlKey || (e.originalEvent as MouseEvent).metaKey;
      if (isDirectDownload && info.url) openUrl(info.url);
    };

    const handleMouseMove = rafThrottle((e: maplibregl.MapMouseEvent) => {
      const feature = getInteractiveFeaturesAtPoint(map, e.point)[0];
      if (!feature) {
        map.getCanvas().style.cursor = "";
        clearHover(map);
        return;
      }
      map.getCanvas().style.cursor = "pointer";
      const tile = getTileFromRenderedFeature(feature);
      if (!tile) {
        clearHover(map);
        return;
      }
      if (hoverKeyRef.current === tile.id) return;
      hoverKeyRef.current = tile.id;
      setHoverSourceData(map, tile);
    });

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = "";
      clearHover(map);
    };

    const handleMoveEnd = () => {
      setMapZoom(map.getZoom());
      scheduleRefresh(map, { delay: 80, reloadData: false, reason: "moveend" });
    };

    const handleLoad = async () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      setHoverSourceData(map, null);
      hasInitialLoadCompletedRef.current = true;
      setMapZoom(map.getZoom());
      if (aoiRef.current) fitMapToAoi(map, aoiRef.current);
      else await refreshTiles(map, { reloadData: true });
    };

    map.on("load", handleLoad);
    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);
    map.on("mouseout", handleMouseLeave);
    map.on("moveend", handleMoveEnd);
    mapRef.current = map;

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      map.off("load", handleLoad);
      map.off("click", handleClick);
      map.off("mousemove", handleMouseMove);
      map.off("mouseout", handleMouseLeave);
      map.off("moveend", handleMoveEnd);
      map.remove();
      mapRef.current = null;
    };
  }, [styleSpec, styleSpecKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasInitialLoadCompletedRef.current || lastAppliedStyleKeyRef.current === styleSpecKey) return;
    lastAppliedStyleKeyRef.current = styleSpecKey;
    lastRefreshKeyRef.current = "";
    map.setStyle(styleSpec);
    map.once("styledata", async () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      setHoverSourceData(map, null);
      hoverKeyRef.current = "";
      await refreshTiles(map, { reloadData: false });
    });
  }, [styleSpec, styleSpecKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    setAoiSourceData(map, aoiRef.current);
    lastRefreshKeyRef.current = "";
    clearAoiIntersectCache();

    if (!props.aoi) {
      lastFittedAoiKeyRef.current = "";
      clearSelectionImmediately(map);
      scheduleRefresh(map, { delay: 0, reloadData: false, reason: "aoi-cleared" });
      return;
    }

    const aoiKey = buildAoiKey(props.aoi);
    const hasMovedToNewAoi = lastFittedAoiKeyRef.current !== aoiKey;
    if (hasMovedToNewAoi) {
      const handleAoiMoveEnd = () => {
        map.off("moveend", handleAoiMoveEnd);
        scheduleRefresh(map, { delay: 0, reloadData: true, reason: "aoi-fit-moveend" });
      };
      map.on("moveend", handleAoiMoveEnd);
      fitMapToAoi(map, props.aoi);
      return;
    }

    scheduleRefresh(map, { delay: 0, reloadData: false, reason: "aoi-updated" });
  }, [props.aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    lastRefreshKeyRef.current = "";
    clearAoiIntersectCache();
    clearSelectionImmediately(map);
    scheduleRefresh(map, { delay: 0, reloadData: true, reason: "selected-product-change" });
  }, [props.selectedProduct]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    lastRefreshKeyRef.current = "";
    scheduleRefresh(map, { delay: 0, reloadData: false, reason: "year-filter-change" });
  }, [props.yearFilter.lidar, props.yearFilter.mnt]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="map" style={{ position: "absolute", inset: 0 }} />

      {(showLidarZoomHint || showMntZoomHint) && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 20,
            maxWidth: 420,
            background: "rgba(255,255,255,0.96)",
            border: "1px solid #d1d5db",
            borderRadius: 10,
            boxShadow: "0 10px 24px rgba(0,0,0,0.12)",
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.45,
            color: "#111827",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Zoom insuffisant pour certaines couches</div>
          {showLidarZoomHint && <div>LiDAR disponible à partir du zoom <strong>{MIN_ZOOM_FOR_LIDAR_LOAD}</strong>.</div>}
          {showMntZoomHint && <div>MNT disponible à partir du zoom <strong>{MIN_ZOOM_FOR_MNT_LOAD}</strong>.</div>}
        </div>
      )}

      {panelInfo && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 20,
            width: 320,
            maxWidth: "calc(100% - 24px)",
            background: "rgba(255,255,255,0.96)",
            border: "1px solid #d1d5db",
            borderRadius: 10,
            boxShadow: "0 10px 24px rgba(0,0,0,0.14)",
            padding: 12,
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: "#111827" }}>{panelInfo.name || "Tuile"}</div>
            <button type="button" onClick={() => setPanelInfo(null)} style={{ border: "none", background: "transparent", fontSize: 18, lineHeight: 1, cursor: "pointer", color: "#6b7280" }} aria-label="Fermer" title="Fermer">×</button>
          </div>

          <div style={{ marginBottom: 4 }}><strong>Produit :</strong> {panelInfo.product || "unknown"}</div>
          <div style={{ marginBottom: 4 }}><strong>ID :</strong> {panelInfo.id || "unknown"}</div>
          <div style={{ marginBottom: 4 }}><strong>Année :</strong> {panelInfo.year ?? "N/D"}</div>
          <div style={{ marginBottom: 8 }}><strong>Fournisseur :</strong> {panelInfo.provider ? String(panelInfo.provider) : "N/D"}</div>

          <div style={{ marginBottom: 10, wordBreak: "break-all", color: "#374151" }}>
            <strong>URL :</strong>{" "}
            {panelInfo.url ? panelInfo.url : "URL non disponible"}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={!panelInfo.url}
              onClick={() => openUrl(panelInfo.url)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #2563eb",
                background: panelInfo.url ? "#2563eb" : "#9ca3af",
                color: "#ffffff",
                cursor: panelInfo.url ? "pointer" : "not-allowed",
                fontWeight: 600,
              }}
            >
              Télécharger
            </button>

            <button
              type="button"
              onClick={() => setPanelInfo(null)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#111827",
                cursor: "pointer",
              }}
            >
              Fermer
            </button>
          </div>

          <div style={{ marginTop: 10, color: "#6b7280", fontSize: 12 }}>
            Astuce : Ctrl/Cmd + clic ouvre directement le téléchargement.
          </div>
        </div>
      )}
    </div>
  );
}