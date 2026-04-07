import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
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

type Props = {
  basemaps: BasemapConfig | null;
  aoi: AoiFeature | null;
  showLidar: boolean;
  showMnt: boolean;
  yearFilter: {
    lidar: string | "ALL";
    mnt: string | "ALL";
  };
  onYearsChange?: (years: { lidar: string[]; mnt: string[] }) => void;
  onSelectionChange: (tiles: TileFeature[]) => void;
};

type Dataset = "lidar" | "mnt";

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

type IntersectWorkerRequest = {
  requestId: string;
  aoi: AoiFeature;
  tiles: RuntimeTileFeature[];
};

type IntersectWorkerResponse = {
  requestId: string;
  selectedIds?: string[];
  error?: string;
};

const SRC_LIDAR = "lidar-src";
const SRC_MNT = "mnt-src";
const SRC_LIDAR_LABELS = "lidar-labels-src";
const SRC_MNT_LABELS = "mnt-labels-src";
const SRC_AOI = "aoi-src";
const SRC_HOVER = "hover-src";

const LYR_LIDAR = "lidar-lyr";
const LYR_LIDAR_OUTLINE = "lidar-lyr-outline";
const LYR_LIDAR_SELECTED = "lidar-selected-lyr";
const LYR_LIDAR_LABELS = "lidar-labels-lyr";

const LYR_MNT = "mnt-lyr";
const LYR_MNT_OUTLINE = "mnt-lyr-outline";
const LYR_MNT_SELECTED = "mnt-selected-lyr";
const LYR_MNT_LABELS = "mnt-labels-lyr";

const LYR_AOI = "aoi-lyr";
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

function getGeoJsonSource(map: Map, sourceId: string) {
  return map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
}

function getSelectionLayerIds(dataset: Dataset) {
  return dataset === "lidar"
    ? [LYR_LIDAR, LYR_LIDAR_OUTLINE, LYR_LIDAR_SELECTED, LYR_LIDAR_LABELS]
    : [LYR_MNT, LYR_MNT_OUTLINE, LYR_MNT_SELECTED, LYR_MNT_LABELS];
}

function buildRuntimeKey(dataset: Dataset, normalizedId: string) {
  return `${dataset}::${normalizedId}`;
}

function areSetsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(
    new globalThis.Map()
  );

  const normalizeCacheRef = useRef(
    new WeakMap<TileFeature, ReturnType<typeof normalizeTile>>()
  );
  const centerCacheRef = useRef<globalThis.Map<string, [number, number] | null>>(
    new globalThis.Map()
  );
  const labelCacheRef = useRef<globalThis.Map<string, LabelFeature[]>>(
    new globalThis.Map()
  );
  const sourceDataKeyRef = useRef<globalThis.Map<string, string>>(
    new globalThis.Map()
  );

  const workerRef = useRef<Worker | null>(null);
  const workerSupportedRef = useRef<boolean>(true);

  const requestSeqRef = useRef(0);
  const selectionSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const hoverKeyRef = useRef<string>("");

  const showLidarRef = useRef(props.showLidar);
  const showMntRef = useRef(props.showMnt);
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

  const selectedKeysRef = useRef<{
    lidar: Set<string>;
    mnt: Set<string>;
  }>({
    lidar: new Set<string>(),
    mnt: new Set<string>(),
  });

  const lastViewStateRef = useRef<{
    bboxKey: string;
    showLidar: boolean;
    showMnt: boolean;
  }>({
    bboxKey: "",
    showLidar: false,
    showMnt: false,
  });

  const [panelInfo, setPanelInfo] = useState<PanelInfo | null>(null);
  const panelInfoRef = useRef<PanelInfo | null>(null);

  useEffect(() => {
    showLidarRef.current = props.showLidar;
  }, [props.showLidar]);

  useEffect(() => {
    showMntRef.current = props.showMnt;
  }, [props.showMnt]);

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

  function getNormalized(tile: TileFeature) {
    const cached = normalizeCacheRef.current.get(tile);
    if (cached) return cached;

    const normalized = normalizeTile(tile);
    normalizeCacheRef.current.set(tile, normalized);
    return normalized;
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

  function setSourceDataIfChanged(
    map: Map,
    sourceId: string,
    key: string,
    data: unknown
  ) {
    const source = getGeoJsonSource(map, sourceId);
    if (!source) return;

    const previousKey = sourceDataKeyRef.current.get(sourceId);
    if (previousKey === key) return;

    sourceDataKeyRef.current.set(sourceId, key);
    source.setData(data as any);
  }

  function ensureCustomSourcesAndLayers(map: Map) {
    if (!map.getSource(SRC_LIDAR)) {
      map.addSource(SRC_LIDAR, {
        type: "geojson",
        data: EMPTY_TILE_FC as any,
      });
    }

    if (!map.getSource(SRC_MNT)) {
      map.addSource(SRC_MNT, {
        type: "geojson",
        data: EMPTY_TILE_FC as any,
      });
    }

    if (!map.getSource(SRC_LIDAR_LABELS)) {
      map.addSource(SRC_LIDAR_LABELS, {
        type: "geojson",
        data: EMPTY_LABEL_FC as any,
      });
    }

    if (!map.getSource(SRC_MNT_LABELS)) {
      map.addSource(SRC_MNT_LABELS, {
        type: "geojson",
        data: EMPTY_LABEL_FC as any,
      });
    }

    if (!map.getSource(SRC_AOI)) {
      map.addSource(SRC_AOI, {
        type: "geojson",
        data: EMPTY_AOI_FC as any,
      });
    }

    if (!map.getSource(SRC_HOVER)) {
      map.addSource(SRC_HOVER, {
        type: "geojson",
        data: EMPTY_HOVER_FC as any,
      });
    }

    if (!map.getLayer(LYR_LIDAR)) {
      map.addLayer({
        id: LYR_LIDAR,
        type: "fill",
        source: SRC_LIDAR,
        paint: {
          "fill-color": "#2563eb",
          "fill-opacity": 0.22,
        },
      });
    }

    if (!map.getLayer(LYR_LIDAR_OUTLINE)) {
      map.addLayer({
        id: LYR_LIDAR_OUTLINE,
        type: "line",
        source: SRC_LIDAR,
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 2,
          "line-opacity": 0.95,
        },
      });
    }

    if (!map.getLayer(LYR_LIDAR_SELECTED)) {
      map.addLayer({
        id: LYR_LIDAR_SELECTED,
        type: "fill",
        source: SRC_LIDAR,
        paint: {
          "fill-color": "#00ffff",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.45,
            0,
          ],
        },
      });
    }

    if (!map.getLayer(LYR_LIDAR_LABELS)) {
      map.addLayer({
        id: LYR_LIDAR_LABELS,
        type: "symbol",
        source: SRC_LIDAR_LABELS,
        minzoom: 11,
        layout: {
          "text-field": ["coalesce", ["get", "label_text"], ""],
          "text-size": 11,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });
    }

    if (!map.getLayer(LYR_MNT)) {
      map.addLayer({
        id: LYR_MNT,
        type: "fill",
        source: SRC_MNT,
        paint: {
          "fill-color": "#16a34a",
          "fill-opacity": 0.22,
        },
      });
    }

    if (!map.getLayer(LYR_MNT_OUTLINE)) {
      map.addLayer({
        id: LYR_MNT_OUTLINE,
        type: "line",
        source: SRC_MNT,
        paint: {
          "line-color": "#15803d",
          "line-width": 2,
          "line-opacity": 0.95,
        },
      });
    }

    if (!map.getLayer(LYR_MNT_SELECTED)) {
      map.addLayer({
        id: LYR_MNT_SELECTED,
        type: "fill",
        source: SRC_MNT,
        paint: {
          "fill-color": "#00ffff",
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.45,
            0,
          ],
        },
      });
    }

    if (!map.getLayer(LYR_MNT_LABELS)) {
      map.addLayer({
        id: LYR_MNT_LABELS,
        type: "symbol",
        source: SRC_MNT_LABELS,
        minzoom: 11,
        layout: {
          "text-field": ["coalesce", ["get", "label_text"], ""],
          "text-size": 11,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });
    }

    if (!map.getLayer(LYR_AOI)) {
      map.addLayer({
        id: LYR_AOI,
        type: "line",
        source: SRC_AOI,
        paint: {
          "line-color": "#0066ff",
          "line-width": 2.5,
          "line-opacity": 0.9,
        },
      });
    }

    if (!map.getLayer(LYR_HOVER_FILL)) {
      map.addLayer({
        id: LYR_HOVER_FILL,
        type: "fill",
        source: SRC_HOVER,
        paint: {
          "fill-color": "#f59e0b",
          "fill-opacity": 0.18,
        },
      });
    }

    if (!map.getLayer(LYR_HOVER_OUTLINE)) {
      map.addLayer({
        id: LYR_HOVER_OUTLINE,
        type: "line",
        source: SRC_HOVER,
        paint: {
          "line-color": "#f59e0b",
          "line-width": 3,
          "line-opacity": 1,
        },
      });
    }
  }

  function setDatasetVisibility(map: Map, dataset: Dataset, visible: boolean) {
    const visibility = visible ? "visible" : "none";
    const layerIds = getSelectionLayerIds(dataset);

    for (const id of layerIds) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
    }
  }

  function computeGeometryCenter(
    runtimeKey: string,
    geometry: Geometry
  ): [number, number] | null {
    const cached = centerCacheRef.current.get(runtimeKey);
    if (cached !== undefined) return cached;

    if (!geometry || !geometry.coordinates) {
      centerCacheRef.current.set(runtimeKey, null);
      return null;
    }

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

    visit(geometry.coordinates);

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      centerCacheRef.current.set(runtimeKey, null);
      return null;
    }

    const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
    centerCacheRef.current.set(runtimeKey, center);
    return center;
  }

  function toRuntimeTiles(
    rawTiles: TileFeature[],
    dataset: Dataset
  ): RuntimeTileFeature[] {
    return rawTiles.map((tile) => {
      const normalized = getNormalized(tile);
      const normalizedId = normalized.id;
      const normalizedProduct =
        normalized.product === "lidar" || normalized.product === "mnt"
          ? normalized.product
          : dataset;

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
		  normalized.provider ??
		  tile.properties?.provider ??
		  tile.properties?.SOURCE_DONNEES ??
		  tile.properties?.PROJET
			? String(
				normalized.provider ??
				  tile.properties?.provider ??
				  tile.properties?.SOURCE_DONNEES ??
				  tile.properties?.PROJET
			  )
			: undefined,
        },
      };
    });
  }

  function setTileSourceData(
    map: Map,
    sourceId: string,
    features: RuntimeTileFeature[]
  ) {
    const key = `${sourceId}::${features.map((f) => f.id).join("|")}`;

    const fc: FeatureCollectionOf<TileProps> = {
      type: "FeatureCollection",
      features,
    };

    setSourceDataIfChanged(map, sourceId, key, fc);
  }

  function setLabelSourceData(map: Map, sourceId: string, features: LabelFeature[]) {
    const key = `${sourceId}::${features
      .map((f) => `${f.properties.normalized_id ?? ""}@${f.geometry.coordinates.join(",")}`)
      .join("|")}`;

    const fc: LabelFC = {
      type: "FeatureCollection",
      features,
    };

    setSourceDataIfChanged(map, sourceId, key, fc);
  }

  function setAoiSourceData(map: Map, aoi: AoiFeature | null) {
    const data = aoi
      ? {
          type: "FeatureCollection",
          features: [aoi],
        }
      : EMPTY_AOI_FC;

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
      features: [
        {
          type: "Feature",
          properties: {
            __hover: true,
          },
          geometry: tile.geometry,
        },
      ],
    };

    setSourceDataIfChanged(map, SRC_HOVER, `hover::${tile.id}`, fc);
  }

  function updateLabelSource(
    map: Map,
    dataset: Dataset,
    features: RuntimeTileFeature[]
  ) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR_LABELS : SRC_MNT_LABELS;
    const cacheKey = `${dataset}::${features.map((f) => f.id).join("|")}`;

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
        geometry: {
          type: "Point",
          coordinates: center,
        },
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
    updateLabelSource(map, dataset, runtimeTiles);
  }

  function clearSelectionState(map: Map, dataset: Dataset) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;
    const previous = selectedKeysRef.current[dataset];

    for (const id of previous) {
      try {
        map.setFeatureState({ source: sourceId, id }, { selected: false });
      } catch {
        // ignore missing source/style race
      }
    }

    selectedKeysRef.current[dataset] = new Set<string>();
  }

  function applySelectionState(
    map: Map,
    dataset: Dataset,
    nextSelected: Set<string>,
    forceReapply = false
  ) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;
    const previous = selectedKeysRef.current[dataset];

    if (!forceReapply && areSetsEqual(previous, nextSelected)) {
      return;
    }

    for (const id of previous) {
      if (forceReapply || !nextSelected.has(id)) {
        try {
          map.setFeatureState({ source: sourceId, id }, { selected: false });
        } catch {
          // ignore missing source/style race
        }
      }
    }

    for (const id of nextSelected) {
      if (forceReapply || !previous.has(id)) {
        try {
          map.setFeatureState({ source: sourceId, id }, { selected: true });
        } catch {
          // ignore missing source/style race
        }
      }
    }

    selectedKeysRef.current[dataset] = new Set(nextSelected);
  }

  function findTileByNormalizedId(
    dataset: Dataset,
    normalizedId: string
  ): RuntimeTileFeature | null {
    return lookupByNormalizedIdRef.current[dataset].get(normalizedId) ?? null;
  }

  function getTileFromRenderedFeature(feature: unknown): RuntimeTileFeature | null {
    const rendered = feature as {
      properties?: Record<string, unknown>;
      id?: string | number;
    };

    if (typeof rendered?.id === "string") {
      const runtimeId = rendered.id;
      const dataset = runtimeId.startsWith("lidar::")
        ? "lidar"
        : runtimeId.startsWith("mnt::")
          ? "mnt"
          : null;

      if (dataset) {
        return lookupByRuntimeIdRef.current[dataset].get(runtimeId) ?? null;
      }
    }

    const props = rendered?.properties ?? {};
    const normalizedId =
      typeof props.normalized_id === "string" ? props.normalized_id : "";
    const dataset =
      props.normalized_product === "lidar" || props.__dataset === "lidar"
        ? "lidar"
        : props.normalized_product === "mnt" || props.__dataset === "mnt"
          ? "mnt"
          : null;

    if (normalizedId && dataset) {
      return findTileByNormalizedId(dataset, normalizedId);
    }

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

    const dataset =
      currentPanel.product === "lidar" || currentPanel.product === "mnt"
        ? currentPanel.product
        : null;

    if (!dataset) {
      setPanelInfo(null);
      return;
    }

    const freshTile = findTileByNormalizedId(dataset, currentPanel.id);
    if (freshTile) {
      setPanelInfo(getPanelInfoFromTile(freshTile));
    } else {
      setPanelInfo(null);
    }
  }

  function openUrl(url: string) {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function getInteractiveFeaturesAtPoint(
    map: Map,
    point: maplibregl.PointLike
  ) {
    return map.queryRenderedFeatures(point, {
      layers: [
        LYR_LIDAR,
        LYR_LIDAR_OUTLINE,
        LYR_LIDAR_SELECTED,
        LYR_LIDAR_LABELS,
        LYR_MNT,
        LYR_MNT_OUTLINE,
        LYR_MNT_SELECTED,
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

  function getOrCreateWorker() {
    if (!workerSupportedRef.current) return null;
    if (workerRef.current) return workerRef.current;

    if (typeof Worker === "undefined") {
      workerSupportedRef.current = false;
      return null;
    }

    try {
      workerRef.current = new Worker(
        new URL("../selection/intersect.worker.ts", import.meta.url),
        { type: "module" }
      );
      return workerRef.current;
    } catch (error) {
      console.warn("Web Worker indisponible, fallback synchrone.", error);
      workerSupportedRef.current = false;
      workerRef.current = null;
      return null;
    }
  }

  async function runIntersectWithWorker(
    aoi: AoiFeature,
    tiles: RuntimeTileFeature[]
  ): Promise<Set<string>> {
    const worker = getOrCreateWorker();
    if (!worker) {
      const selected = intersectAoiWithTiles(aoi, tiles);
      return new Set(
        selected
          .map((tile) => String((tile as RuntimeTileFeature).id ?? ""))
          .filter(Boolean)
      );
    }

    return new Promise<Set<string>>((resolve, reject) => {
      const requestId = `intersect-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const handleMessage = (event: MessageEvent<IntersectWorkerResponse>) => {
        const data = event.data;
        if (!data || data.requestId !== requestId) return;

        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);

        if (data.error) {
          reject(new Error(data.error));
          return;
        }

        resolve(new Set((data.selectedIds ?? []).filter(Boolean)));
      };

      const handleError = (event: ErrorEvent) => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        reject(event.error ?? new Error(event.message));
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);

      const payload: IntersectWorkerRequest = {
        requestId,
        aoi,
        tiles,
      };

      worker.postMessage(payload);
    });
  }

  async function refreshSelection(
    map: Map,
    lidarTiles: RuntimeTileFeature[],
    mntTiles: RuntimeTileFeature[]
  ) {
    const selectionRequestId = ++selectionSeqRef.current;
    const aoi = aoiRef.current;

    if (!aoi) {
      applySelectionState(map, "lidar", new Set<string>(), true);
      applySelectionState(map, "mnt", new Set<string>(), true);
      onSelectionChangeRef.current([]);
      return;
    }

    try {
      const [selectedLidarIds, selectedMntIds] = await Promise.all([
        lidarTiles.length ? runIntersectWithWorker(aoi, lidarTiles) : Promise.resolve(new Set<string>()),
        mntTiles.length ? runIntersectWithWorker(aoi, mntTiles) : Promise.resolve(new Set<string>()),
      ]);

      if (selectionRequestId !== selectionSeqRef.current) return;

      applySelectionState(map, "lidar", selectedLidarIds, true);
      applySelectionState(map, "mnt", selectedMntIds, true);

      const selectedLidarTiles = lidarTiles.filter((tile) =>
        selectedLidarIds.has(tile.id)
      );
      const selectedMntTiles = mntTiles.filter((tile) =>
        selectedMntIds.has(tile.id)
      );

      onSelectionChangeRef.current([
        ...selectedLidarTiles,
        ...selectedMntTiles,
      ]);
    } catch (error) {
      console.error("Erreur dans refreshSelection :", error);

      try {
        const selectedLidarFallback = aoi
          ? intersectAoiWithTiles(aoi, lidarTiles)
          : [];
        const selectedMntFallback = aoi ? intersectAoiWithTiles(aoi, mntTiles) : [];

        const selectedLidarIds = new Set(
          selectedLidarFallback
            .map((tile) => String((tile as RuntimeTileFeature).id ?? ""))
            .filter(Boolean)
        );

        const selectedMntIds = new Set(
          selectedMntFallback
            .map((tile) => String((tile as RuntimeTileFeature).id ?? ""))
            .filter(Boolean)
        );

        if (selectionRequestId !== selectionSeqRef.current) return;

        applySelectionState(map, "lidar", selectedLidarIds, true);
        applySelectionState(map, "mnt", selectedMntIds, true);

        onSelectionChangeRef.current([
          ...selectedLidarFallback,
          ...selectedMntFallback,
        ]);
      } catch (fallbackError) {
        console.error("Erreur fallback intersection :", fallbackError);
        applySelectionState(map, "lidar", new Set<string>(), true);
        applySelectionState(map, "mnt", new Set<string>(), true);
        onSelectionChangeRef.current([]);
      }
    }
  }

  async function refreshTiles(
    map: Map,
    options?: {
      reloadData?: boolean;
    }
  ) {
    if (!map.isStyleLoaded()) return;

    ensureCustomSourcesAndLayers(map);

    const requestId = ++requestSeqRef.current;
    const reloadData = options?.reloadData ?? false;

    const showLidar = showLidarRef.current;
    const showMnt = showMntRef.current;

    setDatasetVisibility(map, "lidar", showLidar);
    setDatasetVisibility(map, "mnt", showMnt);

    if (!showLidar && !showMnt) {
      rawLidarTilesRef.current = [];
      rawMntTilesRef.current = [];
      setRuntimeTiles("lidar", []);
      setRuntimeTiles("mnt", []);

      setTileSourceData(map, SRC_LIDAR, []);
      setTileSourceData(map, SRC_MNT, []);
      setLabelSourceData(map, SRC_LIDAR_LABELS, []);
      setLabelSourceData(map, SRC_MNT_LABELS, []);
      clearSelectionState(map, "lidar");
      clearSelectionState(map, "mnt");
      clearHover(map);

      onYearsChangeRef.current?.({ lidar: [], mnt: [] });
      onSelectionChangeRef.current([]);
      setPanelInfo(null);

      lastViewStateRef.current = {
        bboxKey: "",
        showLidar: false,
        showMnt: false,
      };
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
    const mustReload =
      reloadData ||
      bboxKey !== lastViewStateRef.current.bboxKey ||
      showLidar !== lastViewStateRef.current.showLidar ||
      showMnt !== lastViewStateRef.current.showMnt ||
      (showLidar && rawLidarTilesRef.current.length === 0) ||
      (showMnt && rawMntTilesRef.current.length === 0);

    let lidarRaw = rawLidarTilesRef.current;
    let mntRaw = rawMntTilesRef.current;

    if (mustReload) {
      if (showLidar) {
        lidarRaw = await loadTilesForBBox("lidar", bbox, cacheRef.current);
        if (requestId !== requestSeqRef.current) return;
      } else {
        lidarRaw = [];
      }

      if (showMnt) {
        mntRaw = await loadTilesForBBox("mnt", bbox, cacheRef.current);
        if (requestId !== requestSeqRef.current) return;
      } else {
        mntRaw = [];
      }

      rawLidarTilesRef.current = lidarRaw;
      rawMntTilesRef.current = mntRaw;

      lastViewStateRef.current = {
        bboxKey,
        showLidar,
        showMnt,
      };
    }

    const lidarYears = extractAvailableYears(lidarRaw);
    const mntYears = extractAvailableYears(mntRaw);

    onYearsChangeRef.current?.({
      lidar: lidarYears,
      mnt: mntYears,
    });

    const lidarFiltered = showLidar
      ? filterTilesByYear(lidarRaw, yearFilterRef.current.lidar)
      : [];
    const mntFiltered = showMnt
      ? filterTilesByYear(mntRaw, yearFilterRef.current.mnt)
      : [];

    setTilesOnMap(map, "lidar", lidarFiltered);
    setTilesOnMap(map, "mnt", mntFiltered);

    clearHover(map);
    syncPanelInfo();

    const lidarRuntime = displayedLidarTilesRef.current;
    const mntRuntime = displayedMntTilesRef.current;

    queueMicrotask(() => {
      void refreshSelection(map, lidarRuntime, mntRuntime);
    });
  }

  function scheduleRefresh(map: Map, delay = 120, reloadData = false) {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshTiles(map, { reloadData });
    }, delay);
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleSpec,
      center: [-73.6, 45.5],
      zoom: 8,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      const features = getInteractiveFeaturesAtPoint(map, e.point);
      const feature = features[0];
      if (!feature) return;

      const tile = getTileFromRenderedFeature(feature);
      if (!tile) return;

      const info = getPanelInfoFromTile(tile);
      setPanelInfo(info);

      const isDirectDownload =
        (e.originalEvent as MouseEvent).ctrlKey ||
        (e.originalEvent as MouseEvent).metaKey;

      if (isDirectDownload && info.url) {
        openUrl(info.url);
      }
    };

    const handleMouseMove = rafThrottle((e: maplibregl.MapMouseEvent) => {
      const features = getInteractiveFeaturesAtPoint(map, e.point);
      const feature = features[0];

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

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      setHoverSourceData(map, null);
      void refreshTiles(map, { reloadData: true });
    });

    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);
    map.on("mouseout", handleMouseLeave);

    map.on("moveend", () => {
      scheduleRefresh(map, 120, true);
    });

    mapRef.current = map;

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }

      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      map.off("click", handleClick);
      map.off("mousemove", handleMouseMove);
      map.off("mouseout", handleMouseLeave);
      map.remove();
      mapRef.current = null;
    };
  }, [styleSpec]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.setStyle(styleSpec);

    map.once("styledata", () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      setHoverSourceData(map, null);
      hoverKeyRef.current = "";
      void refreshTiles(map, { reloadData: false });
    });
  }, [styleSpec]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    setAoiSourceData(map, aoiRef.current);
    void refreshSelection(
      map,
      displayedLidarTilesRef.current,
      displayedMntTilesRef.current
    );
  }, [props.aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    setDatasetVisibility(map, "lidar", props.showLidar);
    void refreshTiles(map, { reloadData: true });
  }, [props.showLidar]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    setDatasetVisibility(map, "mnt", props.showMnt);
    void refreshTiles(map, { reloadData: true });
  }, [props.showMnt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    void refreshTiles(map, { reloadData: false });
  }, [props.yearFilter.lidar, props.yearFilter.mnt]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
      }}
    >
      <div
        ref={containerRef}
        className="map"
        style={{
          position: "absolute",
          inset: 0,
        }}
      />

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
          <div
            style={{
              display: "flex",
              alignItems: "start",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700, color: "#111827" }}>
              {panelInfo.name || "Tuile"}
            </div>

            <button
              type="button"
              onClick={() => setPanelInfo(null)}
              style={{
                border: "none",
                background: "transparent",
                fontSize: 18,
                lineHeight: 1,
                cursor: "pointer",
                color: "#6b7280",
              }}
              aria-label="Fermer"
              title="Fermer"
            >
              ×
            </button>
          </div>

          <div style={{ marginBottom: 4 }}>
            <strong>Produit :</strong> {panelInfo.product || "unknown"}
          </div>

          <div style={{ marginBottom: 4 }}>
            <strong>ID :</strong> {panelInfo.id || "unknown"}
          </div>

          <div style={{ marginBottom: 4 }}>
            <strong>Année :</strong> {panelInfo.year ?? "N/D"}
          </div>

          <div style={{ marginBottom: 8 }}>
            <strong>Fournisseur :</strong>{" "}
            {panelInfo.provider ? String(panelInfo.provider) : "N/D"}
          </div>

          <div
            style={{
              marginBottom: 10,
              wordBreak: "break-all",
              color: "#374151",
            }}
          >
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

          <div
            style={{
              marginTop: 10,
              color: "#6b7280",
              fontSize: 12,
            }}
          >
            Astuce : Ctrl/Cmd + clic ouvre directement le téléchargement.
          </div>
        </div>
      )}
    </div>
  );
}