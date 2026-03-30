import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { AoiFeature, BasemapConfig, TileFeature } from "../types";
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

const SRC_TILES = "tiles-src";
const SRC_TILE_LABELS = "tiles-labels-src";
const SRC_AOI = "aoi-src";

const LYR_TILES = "tiles-lyr";
const LYR_TILES_OUTLINE = "tiles-lyr-outline";
const LYR_TILES_SELECTED = "tiles-selected-lyr";
const LYR_TILES_LABELS = "tiles-labels-lyr";
const LYR_AOI = "aoi-lyr";

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map());
  const requestSeqRef = useRef(0);

  const showLidarRef = useRef(props.showLidar);
  const showMntRef = useRef(props.showMnt);
  const aoiRef = useRef(props.aoi);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const currentTilesRef = useRef<TileFeature[]>([]);

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

  const styleSpec = useMemo(() => {
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
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    } as any;
  }, [props.basemaps]);

  function ensureCustomSourcesAndLayers(map: Map) {
    if (!map.getSource(SRC_TILES)) {
      map.addSource(SRC_TILES, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getSource(SRC_TILE_LABELS)) {
      map.addSource(SRC_TILE_LABELS, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getSource(SRC_AOI)) {
      map.addSource(SRC_AOI, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer(LYR_TILES)) {
      map.addLayer({
        id: LYR_TILES,
        type: "fill",
        source: SRC_TILES,
        paint: {
          "fill-color": "#ff5500",
          "fill-opacity": 0.35,
        },
      });
    }

    if (!map.getLayer(LYR_TILES_OUTLINE)) {
      map.addLayer({
        id: LYR_TILES_OUTLINE,
        type: "line",
        source: SRC_TILES,
        paint: {
          "line-color": "#cc0000",
          "line-width": 3,
          "line-opacity": 1,
        },
      });
    }

    if (!map.getLayer(LYR_TILES_SELECTED)) {
      map.addLayer({
        id: LYR_TILES_SELECTED,
        type: "fill",
        source: SRC_TILES,
        paint: {
          "fill-color": "#00ffff",
          "fill-opacity": 0.45,
        },
        filter: ["==", ["get", "__selected"], true],
      });
    }

    if (!map.getLayer(LYR_TILES_LABELS)) {
      map.addLayer({
        id: LYR_TILES_LABELS,
        type: "symbol",
        source: SRC_TILE_LABELS,
        minzoom: 11,
        layout: {
          "text-field": ["coalesce", ["get", "label_text"], ""],
          "text-size": 11,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#111111",
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

  function setTileLayersVisibility(map: Map, visible: boolean) {
    const visibility = visible ? "visible" : "none";

    [LYR_TILES, LYR_TILES_OUTLINE, LYR_TILES_SELECTED, LYR_TILES_LABELS].forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
    });
  }

  function openTileDownload(feature: any) {
    const rawFeature = feature as TileFeature;
    const normalized = normalizeTile(rawFeature);

    if (!normalized.url) return;

    window.open(normalized.url, "_blank", "noopener,noreferrer");
  }

  function computeGeometryCenter(geometry: any): [number, number] | null {
    if (!geometry || !geometry.type || !geometry.coordinates) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const visit = (coords: any) => {
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

      for (const c of coords) visit(c);
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

  function updateLabelSource(map: Map, features: TileFeature[]) {
    const src = map.getSource(SRC_TILE_LABELS) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const pointFeatures = features
      .map((feature) => {
        const center = computeGeometryCenter((feature as any).geometry);
        if (!center) return null;

        const normalized = normalizeTile(feature);

        return {
          type: "Feature",
          properties: {
            ...(feature.properties ?? {}),
            label_text: normalized.name,
            normalized_id: normalized.id,
            normalized_product: normalized.product,
            normalized_url: normalized.url,
          },
          geometry: {
            type: "Point",
            coordinates: center,
          },
        };
      })
      .filter(Boolean);

    src.setData({
      type: "FeatureCollection",
      features: pointFeatures as any[],
    } as any);
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

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      void refreshTiles(map);

      map.on("click", LYR_TILES, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        openTileDownload(feature);
      });

      map.on("click", LYR_TILES_LABELS, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        openTileDownload(feature);
      });

      map.on("mouseenter", LYR_TILES, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", LYR_TILES, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("mouseenter", LYR_TILES_LABELS, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", LYR_TILES_LABELS, () => {
        map.getCanvas().style.cursor = "";
      });
    });

    map.on("moveend", () => {
      void refreshTiles(map);
    });

    mapRef.current = map;

    return () => {
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
      void refreshTiles(map);
    });
  }, [styleSpec]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    try {
      const src = map.getSource(SRC_AOI) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;

      const aoi = aoiRef.current;

      src.setData(
        aoi
          ? { type: "FeatureCollection", features: [aoi] }
          : { type: "FeatureCollection", features: [] }
      );

      void refreshSelection(map, currentTilesRef.current);
    } catch (err) {
      console.error("Erreur lors du chargement de l'AOI :", err);
    }
  }, [props.aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void refreshTiles(map);
  }, [props.showLidar, props.showMnt]);

  async function refreshTiles(map: Map) {
    if (!map.isStyleLoaded()) return;

    ensureCustomSourcesAndLayers(map);

    const requestId = ++requestSeqRef.current;

    const showLidar = showLidarRef.current;
    const showMnt = showMntRef.current;

    if (!showLidar && !showMnt) {
      setTileLayersVisibility(map, false);
      setTilesOnMap(map, []);
      onSelectionChangeRef.current([]);
      return;
    }

    setTileLayersVisibility(map, true);

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];

    const tiles: TileFeature[] = [];

    if (showLidar) {
      const lidar = await loadTilesForBBox("lidar", bbox, cacheRef.current);
      if (requestId !== requestSeqRef.current) return;
      tiles.push(...lidar);
    }

    if (showMnt) {
      const mnt = await loadTilesForBBox("mnt", bbox, cacheRef.current);
      if (requestId !== requestSeqRef.current) return;
      tiles.push(...mnt);
    }

    if (requestId !== requestSeqRef.current) return;

    setTilesOnMap(map, tiles);
    await refreshSelection(map, tiles);
  }

  async function refreshSelection(map: Map, tiles: TileFeature[]) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    let selected: TileFeature[] = [];

    try {
      const aoi = aoiRef.current;
      selected = aoi ? intersectAoiWithTiles(aoi, tiles) : [];
    } catch (err) {
      console.error("Erreur dans intersectAoiWithTiles :", err);
      selected = [];
    }

    const selectedKeys = new Set(
      selected.map((tile) => {
        const t = normalizeTile(tile);
        return `${t.product}::${t.id}`;
      })
    );

    const marked = tiles.map((tile) => {
      const t = normalizeTile(tile);
      const key = `${t.product}::${t.id}`;

      return {
        ...tile,
        properties: {
          ...tile.properties,
          __selected: selectedKeys.has(key),
        },
      };
    }) as TileFeature[];

    currentTilesRef.current = marked;

    src.setData({
      type: "FeatureCollection",
      features: marked,
    } as any);

    updateLabelSource(map, marked);
    onSelectionChangeRef.current(selected);
  }

  function setTilesOnMap(map: Map, features: TileFeature[]) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    currentTilesRef.current = features;

    src.setData({
      type: "FeatureCollection",
      features,
    } as any);

    updateLabelSource(map, features);
  }

  return <div ref={containerRef} className="map" />;
}