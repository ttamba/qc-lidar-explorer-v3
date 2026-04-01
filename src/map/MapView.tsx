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
import { normalizeTile } from "../utils/normalizeTile";
import { filterTilesByYear } from "../utils/filterTiles";

type Props = {
  basemaps: BasemapConfig | null;
  aoi: AoiFeature | null;
  showLidar: boolean;
  showMnt: boolean;
  yearFilter: {
    lidar: string | "ALL";
    mnt: string | "ALL";
  };
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
  year?: number | string;
  provider?: string;
  raw: TileFeature;
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

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(
    new globalThis.Map()
  );
  const requestSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const hoverKeyRef = useRef<string>("");

  const showLidarRef = useRef(props.showLidar);
  const showMntRef = useRef(props.showMnt);
  const aoiRef = useRef(props.aoi);
  const onSelectionChangeRef = useRef(props.onSelectionChange);

  const currentLidarTilesRef = useRef<TileFeature[]>([]);
  const currentMntTilesRef = useRef<TileFeature[]>([]);

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

  function getGeoJsonSource(map: Map, sourceId: string) {
    return map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
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
          "fill-opacity": 0.45,
        },
        filter: ["==", ["get", "__selected"], true],
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
          "fill-opacity": 0.45,
        },
        filter: ["==", ["get", "__selected"], true],
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

    const layerIds =
      dataset === "lidar"
        ? [LYR_LIDAR, LYR_LIDAR_OUTLINE, LYR_LIDAR_SELECTED, LYR_LIDAR_LABELS]
        : [LYR_MNT, LYR_MNT_OUTLINE, LYR_MNT_SELECTED, LYR_MNT_LABELS];

    for (const id of layerIds) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
    }
  }

  function setTileSourceData(map: Map, sourceId: string, features: TileFeature[]) {
    const src = getGeoJsonSource(map, sourceId);
    if (!src) return;

    const fc: FeatureCollectionOf<TileProps> = {
      type: "FeatureCollection",
      features,
    };

    src.setData(fc as any);
  }

  function setLabelSourceData(map: Map, sourceId: string, features: LabelFeature[]) {
    const src = getGeoJsonSource(map, sourceId);
    if (!src) return;

    const fc: LabelFC = {
      type: "FeatureCollection",
      features,
    };

    src.setData(fc as any);
  }

  function setAoiSourceData(map: Map, aoi: AoiFeature | null) {
    const src = getGeoJsonSource(map, SRC_AOI);
    if (!src) return;

    const data = aoi
      ? {
          type: "FeatureCollection",
          features: [aoi],
        }
      : EMPTY_AOI_FC;

    src.setData(data as any);
  }

  function setHoverSourceData(map: Map, tile: TileFeature | null) {
    const src = getGeoJsonSource(map, SRC_HOVER);
    if (!src) return;

    if (!tile) {
      src.setData(EMPTY_HOVER_FC as any);
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

    src.setData(fc as any);
  }

  function computeGeometryCenter(geometry: Geometry): [number, number] | null {
    if (!geometry || !geometry.coordinates) return null;

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

      for (const c of coords) {
        visit(c);
      }
    };

    visit(geometry.coordinates);

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return null;
    }

    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  function updateLabelSource(map: Map, features: TileFeature[], dataset: Dataset) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR_LABELS : SRC_MNT_LABELS;

    const pointFeatures: LabelFeature[] = [];

    for (const feature of features) {
      const center = computeGeometryCenter(feature.geometry);
      if (!center) continue;

      const normalized = normalizeTile(feature);

      pointFeatures.push({
        type: "Feature",
        properties: {
          __dataset: dataset,
          label_text: normalized.name ?? "",
          normalized_id: normalized.id,
          normalized_product: normalized.product,
          normalized_url: normalized.url,
        },
        geometry: {
          type: "Point",
          coordinates: center,
        },
      });
    }

    setLabelSourceData(map, sourceId, pointFeatures);
  }

  function setTilesOnMap(map: Map, dataset: Dataset, features: TileFeature[]) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;

    if (dataset === "lidar") {
      currentLidarTilesRef.current = features;
    } else {
      currentMntTilesRef.current = features;
    }

    setTileSourceData(map, sourceId, features);
    updateLabelSource(map, features, dataset);
  }

  function applySelection(
    map: Map,
    dataset: Dataset,
    tiles: TileFeature[],
    selected: TileFeature[]
  ) {
    const sourceId = dataset === "lidar" ? SRC_LIDAR : SRC_MNT;

    const selectedKeys = new Set(
      selected.map((tile) => {
        const t = normalizeTile(tile);
        return `${t.product}::${t.id}`;
      })
    );

    const marked: TileFeature[] = tiles.map((tile) => {
      const t = normalizeTile(tile);
      const key = `${t.product}::${t.id}`;

      return {
        ...tile,
        properties: {
          ...tile.properties,
          __selected: selectedKeys.has(key),
        },
      };
    });

    if (dataset === "lidar") {
      currentLidarTilesRef.current = marked;
    } else {
      currentMntTilesRef.current = marked;
    }

    setTileSourceData(map, sourceId, marked);
    updateLabelSource(map, marked, dataset);
  }

  function findTileByKey(dataset: Dataset, id: string): TileFeature | null {
    const tiles =
      dataset === "lidar"
        ? currentLidarTilesRef.current
        : currentMntTilesRef.current;

    for (const tile of tiles) {
      const normalized = normalizeTile(tile);
      if (normalized.id === id) return tile;
    }

    return null;
  }

  function getTileFromRenderedFeature(feature: unknown): TileFeature | null {
    const rendered = feature as {
      properties?: Record<string, unknown>;
    };

    const props = rendered?.properties ?? {};

    const normalizedId =
      typeof props.normalized_id === "string" ? props.normalized_id : "";
    const normalizedProduct =
      props.normalized_product === "lidar" || props.normalized_product === "mnt"
        ? props.normalized_product
        : props.__dataset === "lidar" || props.__dataset === "mnt"
          ? props.__dataset
          : null;

    if (normalizedId && normalizedProduct) {
      return findTileByKey(normalizedProduct, normalizedId);
    }

    return feature as TileFeature;
  }

  function getPanelInfoFromTile(tile: TileFeature): PanelInfo {
    const normalized = normalizeTile(tile);
    const p = tile.properties ?? {};

    return {
      id: normalized.id,
      name: normalized.name,
      product: normalized.product,
      url: normalized.url,
      year: normalized.year ?? p.year,
      provider:
        normalized.provider ??
        p.provider ??
        p.SOURCE_DONNEES ??
        p.PROJET,
      raw: tile,
    };
  }

  function openUrl(url: string) {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function refreshSelection(
    map: Map,
    lidarTiles: TileFeature[],
    mntTiles: TileFeature[]
  ) {
    let selectedLidar: TileFeature[] = [];
    let selectedMnt: TileFeature[] = [];

    try {
      const aoi = aoiRef.current;
      selectedLidar = aoi ? intersectAoiWithTiles(aoi, lidarTiles) : [];
      selectedMnt = aoi ? intersectAoiWithTiles(aoi, mntTiles) : [];
    } catch (err) {
      console.error("Erreur dans intersectAoiWithTiles :", err);
      selectedLidar = [];
      selectedMnt = [];
    }

    applySelection(map, "lidar", lidarTiles, selectedLidar);
    applySelection(map, "mnt", mntTiles, selectedMnt);

    onSelectionChangeRef.current([...selectedLidar, ...selectedMnt]);
  }

  async function refreshTiles(map: Map) {
    if (!map.isStyleLoaded()) return;

    ensureCustomSourcesAndLayers(map);

    const requestId = ++requestSeqRef.current;

    const showLidar = showLidarRef.current;
    const showMnt = showMntRef.current;

    if (!showLidar && !showMnt) {
      setDatasetVisibility(map, "lidar", false);
      setDatasetVisibility(map, "mnt", false);

      setTilesOnMap(map, "lidar", []);
      setTilesOnMap(map, "mnt", []);
      setHoverSourceData(map, null);
      hoverKeyRef.current = "";

      onSelectionChangeRef.current([]);
      return;
    }

    setDatasetVisibility(map, "lidar", showLidar);
    setDatasetVisibility(map, "mnt", showMnt);

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];

    let lidarTiles: TileFeature[] = [];
    let mntTiles: TileFeature[] = [];

    if (showLidar) {
      lidarTiles = await loadTilesForBBox("lidar", bbox, cacheRef.current);
      if (requestId !== requestSeqRef.current) return;
    }

    if (showMnt) {
      mntTiles = await loadTilesForBBox("mnt", bbox, cacheRef.current);
      if (requestId !== requestSeqRef.current) return;
    }

    if (requestId !== requestSeqRef.current) return;

    // ✅ FILTRAGE PAR ANNÉE
	lidarTiles = filterTilesByYear(
	  lidarTiles,
      props.yearFilter.lidar
	);

	mntTiles = filterTilesByYear(
	  mntTiles,
      props.yearFilter.mnt
	);

	// 🔁 ensuite logique normale
	setTilesOnMap(map, "lidar", lidarTiles);
	setTilesOnMap(map, "mnt", mntTiles);

    await refreshSelection(map, lidarTiles, mntTiles);

    const currentPanel = panelInfoRef.current;
    if (currentPanel) {
      const dataset =
        currentPanel.product === "lidar" || currentPanel.product === "mnt"
          ? currentPanel.product
          : null;

      if (dataset) {
        const freshTile = findTileByKey(dataset, currentPanel.id);
        if (freshTile) {
          setPanelInfo(getPanelInfoFromTile(freshTile));
        } else {
          setPanelInfo(null);
        }
      } else {
        setPanelInfo(null);
      }
    }
  }

  function scheduleRefresh(map: Map, delay = 120) {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshTiles(map);
    }, delay);
  }

  function getInteractiveFeaturesAtPoint(map: Map, point: maplibregl.PointLike) {
    return map.queryRenderedFeatures(point, {
      layers: [
        LYR_LIDAR,
        LYR_LIDAR_OUTLINE,
        LYR_LIDAR_LABELS,
        LYR_MNT,
        LYR_MNT_OUTLINE,
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

    const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
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

      const normalized = normalizeTile(tile);
      const key = `${normalized.product}::${normalized.id}`;

      if (hoverKeyRef.current === key) return;

      hoverKeyRef.current = key;
      setHoverSourceData(map, tile);
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = "";
      clearHover(map);
    };

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      setHoverSourceData(map, null);
      void refreshTiles(map);
    });

    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);
    map.on("mouseout", handleMouseLeave);

    map.on("moveend", () => {
      scheduleRefresh(map, 120);
    });

    mapRef.current = map;

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
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
      void refreshTiles(map);
    });
  }, [styleSpec]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    try {
      setAoiSourceData(map, aoiRef.current);
      void refreshSelection(
        map,
        currentLidarTilesRef.current,
        currentMntTilesRef.current
      );
    } catch (err) {
      console.error("Erreur lors du chargement de l'AOI :", err);
    }
  }, [props.aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    setDatasetVisibility(map, "lidar", props.showLidar);
    void refreshTiles(map);
  }, [props.showLidar]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    setDatasetVisibility(map, "mnt", props.showMnt);
    void refreshTiles(map);
  }, [props.showMnt]);

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
            <strong>Année :</strong>{" "}
            {panelInfo.year !== undefined && panelInfo.year !== ""
              ? String(panelInfo.year)
              : "N/D"}
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