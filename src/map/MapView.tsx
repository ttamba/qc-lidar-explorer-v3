import { useEffect, useMemo, useRef } from "react";
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

type Props = {
  basemaps: BasemapConfig | null;
  aoi: AoiFeature | null;
  showLidar: boolean;
  showMnt: boolean;
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

const SRC_LIDAR = "lidar-src";
const SRC_MNT = "mnt-src";
const SRC_LIDAR_LABELS = "lidar-labels-src";
const SRC_MNT_LABELS = "mnt-labels-src";
const SRC_AOI = "aoi-src";

const LYR_LIDAR = "lidar-lyr";
const LYR_LIDAR_OUTLINE = "lidar-lyr-outline";
const LYR_LIDAR_SELECTED = "lidar-selected-lyr";
const LYR_LIDAR_LABELS = "lidar-labels-lyr";

const LYR_MNT = "mnt-lyr";
const LYR_MNT_OUTLINE = "mnt-lyr-outline";
const LYR_MNT_SELECTED = "mnt-selected-lyr";
const LYR_MNT_LABELS = "mnt-labels-lyr";

const LYR_AOI = "aoi-lyr";

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

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(
    new globalThis.Map()
  );
  const requestSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);

  const showLidarRef = useRef(props.showLidar);
  const showMntRef = useRef(props.showMnt);
  const aoiRef = useRef(props.aoi);
  const onSelectionChangeRef = useRef(props.onSelectionChange);

  const currentLidarTilesRef = useRef<TileFeature[]>([]);
  const currentMntTilesRef = useRef<TileFeature[]>([]);

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

  function getUrlFromRenderedFeature(feature: unknown): string {
    const rendered = feature as {
      properties?: Record<string, unknown>;
    };

    const props = rendered?.properties ?? {};

    const labelUrl = props.normalized_url;
    if (typeof labelUrl === "string" && labelUrl.trim()) {
      return labelUrl.trim();
    }

    try {
      const normalized = normalizeTile(feature as TileFeature);
      return normalized.url ?? "";
    } catch {
      return "";
    }
  }

  function openFeatureDownload(feature: unknown) {
    const url = getUrlFromRenderedFeature(feature);
    if (!url) return;

    window.open(url, "_blank", "noopener,noreferrer");
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

    setTilesOnMap(map, "lidar", lidarTiles);
    setTilesOnMap(map, "mnt", mntTiles);

    await refreshSelection(map, lidarTiles, mntTiles);
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
      openFeatureDownload(feature);
    };

    const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
      const features = getInteractiveFeaturesAtPoint(map, e.point);
      map.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";
    };

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      setAoiSourceData(map, aoiRef.current);
      void refreshTiles(map);
    });

    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);

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

  return <div ref={containerRef} className="map" />;
}