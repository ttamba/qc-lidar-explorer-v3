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

/**
 * MapView
 * ----------
 * Composant principal de rendu cartographique basé sur MapLibre.
 *
 * Responsabilités :
 * - chargement dynamique des tuiles par emprise
 * - intersection AOI ↔ tuiles
 * - application des filtres produit / année
 * - mise à jour des sources et layers GeoJSON
 * - gestion de la sélection, du hover et du panneau d’information
 * - cache des résultats coûteux pour améliorer la fluidité
 * - gestion des fonds cartographiques et des contrôles de carte
 */

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

type MapStatusTone = "info" | "warning" | "error";

type MapStatus = {
  tone: MapStatusTone;
  title: string;
  detail?: string;
} | null;

type BasemapOption = {
  id: string;
  label: string;
  subtitle: string;
  tiles: string[];
  tileSize: number;
  attribution: string;
};

/**
 * Identifiants des sources GeoJSON MapLibre
 * (séparés par dataset + usage : brut, sélection, labels, hover, AOI)
 */
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

/**
 * Throttle basé sur requestAnimationFrame
 * → évite les recalculs trop fréquents sur mousemove
 */
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

/**
 * Outils de profiling activés uniquement en DEV
 * → permet d’analyser les performances de refreshTiles
 */
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

/**
 * Extraction rapide de bbox à partir d’une géométrie GeoJSON
 * → utilisé pour :
 *   - calcul centre
 *   - fit AOI
 *   - optimisations diverses
 */
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

function getMapStatusStyle(tone: MapStatusTone): React.CSSProperties {
  switch (tone) {
    case "warning":
      return {
        border: "1px solid #fcd34d",
        background: "rgba(255,251,235,0.97)",
        color: "#92400e",
      };
    case "error":
      return {
        border: "1px solid #fca5a5",
        background: "rgba(254,242,242,0.97)",
        color: "#991b1b",
      };
    case "info":
    default:
      return {
        border: "1px solid #bfdbfe",
        background: "rgba(239,246,255,0.97)",
        color: "#1d4ed8",
      };
  }
}

function getBadgeStyle(kind: "neutral" | "product" | "year"): React.CSSProperties {
  if (kind === "product") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "4px 8px",
      borderRadius: 999,
      background: "#eff6ff",
      color: "#1d4ed8",
      border: "1px solid #bfdbfe",
      fontSize: 11,
      fontWeight: 700,
    };
  }

  if (kind === "year") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "4px 8px",
      borderRadius: 999,
      background: "#f3f4f6",
      color: "#374151",
      border: "1px solid #e5e7eb",
      fontSize: 11,
      fontWeight: 700,
    };
  }

  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 999,
    background: "#f9fafb",
    color: "#374151",
    border: "1px solid #e5e7eb",
    fontSize: 11,
    fontWeight: 600,
  };
}

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Refs centrales du moteur MapView
   * --------------------------------
   * On évite React state ici pour performance :
   * - cache données (tiles, labels, centres)
   * - lookup rapides (id → feature)
   * - gestion sélection
   * - synchronisation avec MapLibre
   */
  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map());
  const normalizeCacheRef = useRef(new WeakMap<TileFeature, ReturnType<typeof normalizeTile>>());
  const centerCacheRef = useRef<globalThis.Map<string, [number, number] | null>>(new globalThis.Map());
  const labelCacheRef = useRef<globalThis.Map<string, LabelFeature[]>>(new globalThis.Map());
  const sourceDataKeyRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());

  /**
   * Cache des résultats d’intersection AOI
   * clé = dataset + bbox + aoi + signature tiles
   */
  const aoiIntersectCacheRef = useRef<{
    lidar: globalThis.Map<string, TileFeature[]>;
    mnt: globalThis.Map<string, TileFeature[]>;
  }>({
    lidar: new globalThis.Map(),
    mnt: new globalThis.Map(),
  });

  /**
   * Cache des années disponibles dérivées de l’AOI
   * → évite recalcul inutile sur chaque refresh
   */
  const availableYearsCacheRef = useRef<{
    lidar: globalThis.Map<string, string[]>;
    mnt: globalThis.Map<string, string[]>;
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
  const refreshUiSeqRef = useRef(0);
  const scaleControlAddedRef = useRef(false);

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

  /**
   * États UX carte :
   * - chargement discret
   * - message contextuel sur la carte
   * - menu de fonds cartographiques
   */
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mapStatus, setMapStatus] = useState<MapStatus>(null);
  const [isBasemapMenuOpen, setIsBasemapMenuOpen] = useState(true);
  const [selectedBasemapId, setSelectedBasemapId] = useState("osm");

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

  /**
   * Catalogue des fonds de carte :
   * - OSM
   * - 3 services web cartographiques officiels du Québec
   */
  const basemapOptions = useMemo<BasemapOption[]>(() => {
    const customOsm = props.basemaps?.basemaps?.[0];

    return [
      {
        id: "osm",
        label: "OpenStreetMap",
        subtitle: "Fond général",
        tiles: customOsm?.tiles ?? ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: customOsm?.tileSize ?? 256,
        attribution: customOsm?.attribution ?? "© OpenStreetMap contributors",
      },
      {
        id: "qc-bdtq-20k",
        label: "Québec Topo 1:20 000",
        subtitle: "Gouvernement du Québec",
        tiles: [
          "https://geoegl.msp.gouv.qc.ca/carto/wmts/1.0.0/carte_gouv_qc_public/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png",
        ],
        tileSize: 256,
        attribution: "© Gouvernement du Québec",
      },
      {
        id: "qc-bdat-100k",
        label: "Québec Topo 1:100 000",
        subtitle: "Gouvernement du Québec",
        tiles: [
          "https://servicesmatriciels.mern.gouv.qc.ca/erdas-iws/ogc/wmts/Cartes_Images?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=BDAT-100k&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png",
        ],
        tileSize: 256,
        attribution: "© Gouvernement du Québec",
      },
      {
        id: "qc-bdga-1m",
        label: "Québec BDGA 1:1 000 000",
        subtitle: "Gouvernement du Québec",
        tiles: [
          "https://servicesmatriciels.mern.gouv.qc.ca/erdas-iws/ogc/wmts/Cartes_Images?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=BDGA-1M_Carte_Generale_Couleur&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png",
        ],
        tileSize: 256,
        attribution: "© Gouvernement du Québec",
      },
    ];
  }, [props.basemaps]);

  const currentBasemap = useMemo(() => {
    return basemapOptions.find((item) => item.id === selectedBasemapId) ?? basemapOptions[0];
  }, [basemapOptions, selectedBasemapId]);

  const styleSpec = useMemo<maplibregl.StyleSpecification>(() => {
    return {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: currentBasemap.tiles,
          tileSize: currentBasemap.tileSize,
          attribution: currentBasemap.attribution,
        },
      },
      layers: [
        {
          id: "basemap",
          type: "raster",
          source: "basemap",
        },
      ],
    };
  }, [currentBasemap]);

  const styleSpecKey = useMemo(
    () => JSON.stringify({ basemapId: currentBasemap.id, styleSpec }),
    [currentBasemap.id, styleSpec]
  );

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

  function buildAoiDerivedCacheKey(
    dataset: Dataset,
    bboxKey: string,
    aoiKey: string,
    tiles: TileFeature[]
  ) {
    return `${dataset}|${bboxKey}|${aoiKey}|${getTileArraySignature(tiles)}`;
  }

  function clearAoiDerivedCaches(dataset?: Dataset) {
    if (!dataset) {
      aoiIntersectCacheRef.current.lidar.clear();
      aoiIntersectCacheRef.current.mnt.clear();
      availableYearsCacheRef.current.lidar.clear();
      availableYearsCacheRef.current.mnt.clear();
      return;
    }

    aoiIntersectCacheRef.current[dataset].clear();
    availableYearsCacheRef.current[dataset].clear();
  }

  /**
   * Applique intersection AOI ↔ tuiles avec cache
   * → point critique performance
   */
  function getAoiFilteredTiles(
    dataset: Dataset,
    bboxKey: string,
    aoi: AoiFeature | null,
    tiles: TileFeature[]
  ): TileFeature[] {
    if (!aoi || tiles.length === 0) return tiles;

    const aoiKey = buildAoiKey(aoi);
    const cacheKey = buildAoiDerivedCacheKey(dataset, bboxKey, aoiKey, tiles);
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

  /**
   * Calcule les années disponibles à partir des tuiles AOI
   * avec mémoïsation
   */
  function getAvailableYearsForAoiTiles(
    dataset: Dataset,
    bboxKey: string,
    aoi: AoiFeature | null,
    rawTiles: TileFeature[],
    aoiTiles: TileFeature[]
  ): string[] {
    const aoiKey = buildAoiKey(aoi);
    const cacheKey = buildAoiDerivedCacheKey(dataset, bboxKey, aoiKey, rawTiles);

    const cache = availableYearsCacheRef.current[dataset];
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const years = extractAvailableYears(aoiTiles);
    cache.set(cacheKey, years);

    if (cache.size > 12) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    return years;
  }

  /**
   * Met à jour les tableaux runtime et les lookup rapides
   * utilisés par les interactions carte.
   */
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

  /**
   * Initialise toutes les sources et layers MapLibre
   * (idempotent)
   */
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

  /**
   * Normalise les tuiles :
   * - ajoute id runtime stable
   * - enrichit properties (product, url, name, year, provider)
   */
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

  /**
   * Applique la sélection via feature-state MapLibre
   * optimisation :
   * - diff entre ancienne et nouvelle sélection
   * - évite re-render inutile
   */
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

  /**
   * Sélection automatique :
   * toutes les tuiles affichées sont sélectionnées si AOI active
   */
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

  /**
   * Résolution feature MapLibre → tuile runtime
   * support :
   * - id runtime
   * - normalized_id
   */
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

  /**
   * Met à jour le message UX de carte en fonction du contexte courant.
   */
  function computeMapStatus(params: {
    dataset: Dataset;
    activeYear: string | "ALL";
    showDataset: boolean;
    hasAoi: boolean;
    rawCount: number;
    aoiCount: number;
    displayCount: number;
  }): MapStatus {
    const { dataset, activeYear, showDataset, hasAoi, rawCount, aoiCount, displayCount } = params;

    if (!showDataset) {
      return {
        tone: "info",
        title: "Zoom insuffisant",
        detail:
          dataset === "lidar"
            ? `Zoomez au moins jusqu’au niveau ${MIN_ZOOM_FOR_LIDAR_LOAD} pour charger les tuiles LiDAR.`
            : `Zoomez au moins jusqu’au niveau ${MIN_ZOOM_FOR_MNT_LOAD} pour charger les tuiles MNT.`,
      };
    }

    if (rawCount === 0) {
      return {
        tone: "info",
        title: "Aucune tuile disponible",
        detail: "Aucune donnée n’a été trouvée dans l’emprise courante.",
      };
    }

    if (hasAoi && aoiCount === 0) {
      return {
        tone: "warning",
        title: "AOI hors couverture",
        detail: "Aucune tuile n’intersecte la zone d’étude pour le produit actif.",
      };
    }

    if (displayCount === 0 && activeYear !== "ALL") {
      return {
        tone: "info",
        title: "Aucun résultat pour ce millésime",
        detail: `Aucune tuile ${dataset.toUpperCase()} n’est disponible pour l’année ${activeYear} dans le contexte courant.`,
      };
    }

    return null;
  }

  /**
   * refreshTiles
   * ------------------
   * Pipeline principal de la carte :
   *
   * 1. Détermine dataset actif + zoom
   * 2. Charge tuiles bbox (si nécessaire)
   * 3. Applique cache AOI
   * 4. Calcule années disponibles
   * 5. Applique filtre année
   * 6. Met à jour sources/layers
   * 7. Met à jour sélection
   */
  async function refreshTiles(map: Map, options?: { reloadData?: boolean }) {
    perfMark("refreshTiles:start");
    const uiSeq = ++refreshUiSeqRef.current;
    setIsRefreshing(true);

    try {
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
        clearAoiDerivedCaches();
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

        if (uiSeq === refreshUiSeqRef.current) {
          setMapStatus(
            computeMapStatus({
              dataset: activeDataset,
              activeYear: activeDataset === "lidar" ? yearFilterRef.current.lidar : yearFilterRef.current.mnt,
              showDataset: false,
              hasAoi: Boolean(aoiRef.current),
              rawCount: 0,
              aoiCount: 0,
              displayCount: 0,
            })
          );
        }

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
          clearAoiDerivedCaches("lidar");
        } else if (showMnt) {
          mntRaw = await loadTilesForBBox("mnt", bbox, cacheRef.current);
          if (requestId !== requestSeqRef.current) return;
          lidarRaw = [];
          clearAoiDerivedCaches("mnt");
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

      const lidarYears = showLidar
        ? getAvailableYearsForAoiTiles("lidar", bboxKey, aoi, lidarRaw, lidarAoiTiles)
        : [];

      const mntYears = showMnt
        ? getAvailableYearsForAoiTiles("mnt", bboxKey, aoi, mntRaw, mntAoiTiles)
        : [];

      onYearsChangeRef.current?.({
        lidar: lidarYears,
        mnt: mntYears,
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

      const activeRawCount = activeDataset === "lidar" ? lidarRaw.length : mntRaw.length;
      const activeAoiCount = activeDataset === "lidar" ? lidarAoiTiles.length : mntAoiTiles.length;
      const activeDisplayCount = activeDataset === "lidar" ? lidarDisplayTiles.length : mntDisplayTiles.length;

      if (uiSeq === refreshUiSeqRef.current) {
        setMapStatus(
          computeMapStatus({
            dataset: activeDataset,
            activeYear,
            showDataset: true,
            hasAoi: Boolean(aoi),
            rawCount: activeRawCount,
            aoiCount: activeAoiCount,
            displayCount: activeDisplayCount,
          })
        );
      }

      lastRefreshKeyRef.current = refreshKey;
    } catch (error) {
      console.error("Erreur dans refreshTiles :", error);

      if (uiSeq === refreshUiSeqRef.current) {
        setMapStatus({
          tone: "error",
          title: "Erreur de chargement cartographique",
          detail: error instanceof Error ? error.message : "Une erreur inconnue est survenue.",
        });
      }
    } finally {
      if (uiSeq === refreshUiSeqRef.current) {
        setIsRefreshing(false);
      }
      perfMark("refreshTiles:end");
      perfMeasure("refreshTiles:total", "refreshTiles:start", "refreshTiles:end");
    }
  }

  /**
   * Debounce + batching des refresh
   * permet :
   * - éviter spam refresh lors du pan/zoom
   * - fusionner plusieurs triggers
   */
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

  /**
   * Initialisation de la carte MapLibre
   * + binding des événements :
   * - click
   * - hover
   * - moveend
   * - ajout des contrôles de navigation et d’échelle
   */
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

    if (!scaleControlAddedRef.current) {
      map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
      scaleControlAddedRef.current = true;
    }

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

      if (aoiRef.current) {
        fitMapToAoi(map, aoiRef.current);
      } else {
        await refreshTiles(map, { reloadData: true });
      }
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
      scaleControlAddedRef.current = false;
    };
  }, [styleSpec, styleSpecKey]);

  /**
   * Réagit au changement de style de fond
   * et réinjecte ensuite les couches métier.
   */
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

  /**
   * Réagit au changement d’AOI :
   * - reset caches
   * - fit sur AOI
   * - relance pipeline
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    setAoiSourceData(map, aoiRef.current);
    lastRefreshKeyRef.current = "";
    clearAoiDerivedCaches();

    if (!props.aoi) {
      lastFittedAoiKeyRef.current = "";
      clearSelectionImmediately(map);
      setMapStatus(null);
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

  /**
   * Changement produit :
   * - reset sélection
   * - reload données
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    lastRefreshKeyRef.current = "";
    clearAoiDerivedCaches();
    clearSelectionImmediately(map);
    setMapStatus(null);
    scheduleRefresh(map, { delay: 0, reloadData: true, reason: "selected-product-change" });
  }, [props.selectedProduct]);

  /**
   * Changement filtre année :
   * - refresh léger sans reload brut
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    lastRefreshKeyRef.current = "";
    setMapStatus(null);
    scheduleRefresh(map, { delay: 0, reloadData: false, reason: "year-filter-change" });
  }, [props.yearFilter.lidar, props.yearFilter.mnt]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="map" style={{ position: "absolute", inset: 0 }} />

      {/* Menu rétractable des fonds cartographiques */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 32,
          width: isBasemapMenuOpen ? 320 : "auto",
          maxWidth: "calc(100% - 24px)",
          borderRadius: 14,
          border: "1px solid #d1d5db",
          background: "rgba(255,255,255,0.97)",
          boxShadow: "0 12px 26px rgba(0,0,0,0.12)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "10px 12px",
            borderBottom: isBasemapMenuOpen ? "1px solid #e5e7eb" : "none",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#111827" }}>
              Fonds cartographiques
            </div>
            {isBasemapMenuOpen && (
              <div style={{ marginTop: 2, fontSize: 11, color: "#6b7280" }}>
                OSM + services Web du gouvernement du Québec
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsBasemapMenuOpen((prev) => !prev)}
            style={{
              border: "1px solid #d1d5db",
              background: "#ffffff",
              borderRadius: 10,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              color: "#111827",
            }}
            title={isBasemapMenuOpen ? "Réduire" : "Déployer"}
          >
            {isBasemapMenuOpen ? "Réduire" : "Fonds"}
          </button>
        </div>

        {isBasemapMenuOpen && (
          <div style={{ padding: 12 }}>
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 12,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>
                Fond actif
              </div>
              <div style={{ fontWeight: 700, color: "#111827" }}>{currentBasemap.label}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {currentBasemap.subtitle}
              </div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {basemapOptions.map((option) => {
                const isActive = option.id === currentBasemap.id;

                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSelectedBasemapId(option.id)}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: isActive ? "1px solid #2563eb" : "1px solid #e5e7eb",
                      background: isActive ? "#eff6ff" : "#ffffff",
                      color: "#111827",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{option.label}</div>
                    <div style={{ marginTop: 2, fontSize: 12, color: "#6b7280" }}>
                      {option.subtitle}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Loader discret pendant l’actualisation de la carte */}
      {isRefreshing && (
        <div
          style={{
            position: "absolute",
            top: isBasemapMenuOpen ? 240 : 64,
            left: 12,
            zIndex: 30,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid #d1d5db",
            background: "rgba(255,255,255,0.96)",
            boxShadow: "0 8px 18px rgba(0,0,0,0.10)",
            fontSize: 12,
            color: "#111827",
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#2563eb",
              flex: "0 0 auto",
            }}
          />
          Actualisation de la carte…
        </div>
      )}

      {/* Message contextuel : aucun résultat, AOI hors couverture, erreur, etc. */}
      {mapStatus && !isRefreshing && (
        <div
          style={{
            position: "absolute",
            top: isBasemapMenuOpen ? 240 : 64,
            left: 12,
            zIndex: 29,
            maxWidth: 420,
            borderRadius: 12,
            boxShadow: "0 10px 24px rgba(0,0,0,0.10)",
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.45,
            ...getMapStatusStyle(mapStatus.tone),
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: mapStatus.detail ? 4 : 0 }}>
            {mapStatus.title}
          </div>
          {mapStatus.detail && <div>{mapStatus.detail}</div>}
        </div>
      )}

      {/* Indication utilisateur : zoom insuffisant pour le dataset actif */}
      {(showLidarZoomHint || showMntZoomHint) && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 58,
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

      {/* Panneau d’information tuile :
          - metadata
          - accès téléchargement
          - interaction utilisateur */}
      {panelInfo && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 20,
            width: 360,
            maxWidth: "calc(100% - 24px)",
            background: "rgba(255,255,255,0.97)",
            border: "1px solid #d1d5db",
            borderRadius: 16,
            boxShadow: "0 16px 32px rgba(0,0,0,0.16)",
            padding: 14,
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "start",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 16,
                  color: "#111827",
                  lineHeight: 1.25,
                  marginBottom: 8,
                  wordBreak: "break-word",
                }}
              >
                {panelInfo.name || "Tuile"}
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span style={getBadgeStyle("product")}>
                  {panelInfo.product ? panelInfo.product.toUpperCase() : "UNKNOWN"}
                </span>
                <span style={getBadgeStyle("year")}>
                  {panelInfo.year ?? "Année N/D"}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setPanelInfo(null)}
              style={{
                border: "1px solid #d1d5db",
                background: "#ffffff",
                width: 34,
                height: 34,
                borderRadius: 10,
                fontSize: 18,
                lineHeight: 1,
                cursor: "pointer",
                color: "#6b7280",
                flex: "0 0 auto",
              }}
              aria-label="Fermer"
              title="Fermer"
            >
              ×
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>Identifiant</div>
              <div style={{ fontWeight: 700, color: "#111827", wordBreak: "break-word" }}>
                {panelInfo.id || "unknown"}
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>Fournisseur</div>
              <div style={{ fontWeight: 600, color: "#111827", wordBreak: "break-word" }}>
                {panelInfo.provider ? String(panelInfo.provider) : "N/D"}
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>URL</div>
              <div style={{ color: "#374151", wordBreak: "break-all" }}>
                {panelInfo.url ? panelInfo.url : "URL non disponible"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={!panelInfo.url}
              onClick={() => openUrl(panelInfo.url)}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #2563eb",
                background: panelInfo.url ? "#2563eb" : "#9ca3af",
                color: "#ffffff",
                cursor: panelInfo.url ? "pointer" : "not-allowed",
                fontWeight: 700,
              }}
            >
              Télécharger
            </button>

            <button
              type="button"
              onClick={() => setPanelInfo(null)}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#111827",
                cursor: "pointer",
                fontWeight: 600,
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