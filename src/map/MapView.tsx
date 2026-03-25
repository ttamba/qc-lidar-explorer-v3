import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { AoiFeature, BasemapConfig, TileFeature } from "../types";
import { loadTilesForBBox } from "../index/loadChunks";
import { intersectAoiWithTiles } from "../selection/intersect";

type Props = {
  basemaps: BasemapConfig | null;
  aoi: AoiFeature | null;
  showLidar: boolean;
  showMnt: boolean;
  onSelectionChange: (tiles: TileFeature[]) => void;
};

const SRC_TILES = "tiles-src";
const LYR_TILES = "tiles-lyr";
const LYR_TILES_OUTLINE = "tiles-lyr-outline";
const LYR_TILES_SELECTED = "tiles-selected-lyr";
const SRC_AOI = "aoi-src";
const LYR_AOI = "aoi-lyr";

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map());
  const requestSeqRef = useRef(0);

  // 🔥 refs pour éviter stale closure
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

    if (!map.getLayer(LYR_TILES)) {
      map.addLayer({
        id: LYR_TILES,
        type: "fill",
        source: SRC_TILES,
        paint: { "fill-color": "#ff5500", "fill-opacity": 0.35 },
      });
    }

    if (!map.getLayer(LYR_TILES_OUTLINE)) {
      map.addLayer({
        id: LYR_TILES_OUTLINE,
        type: "line",
        source: SRC_TILES,
        paint: { "line-color": "#cc0000", "line-width": 3 },
      });
    }

    if (!map.getLayer(LYR_TILES_SELECTED)) {
      map.addLayer({
        id: LYR_TILES_SELECTED,
        type: "fill",
        source: SRC_TILES,
        paint: { "fill-color": "#00ffff", "fill-opacity": 0.45 },
        filter: ["==", ["get", "__selected"], true],
      });
    }

    if (!map.getSource(SRC_AOI)) {
      map.addSource(SRC_AOI, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer(LYR_AOI)) {
      map.addLayer({
        id: LYR_AOI,
        type: "line",
        source: SRC_AOI,
        paint: { "line-color": "#0066ff", "line-width": 2.5 },
      });
    }
  }

  function setTileLayersVisibility(map: Map, visible: boolean) {
    const visibility = visible ? "visible" : "none";

    [LYR_TILES, LYR_TILES_OUTLINE, LYR_TILES_SELECTED].forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visibility);
      }
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

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      void refreshTiles(map);
    });

    // 🔥 handler stable
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

    const src = map.getSource(SRC_AOI) as maplibregl.GeoJSONSource;
    const aoi = aoiRef.current;

    src.setData(
      aoi
        ? { type: "FeatureCollection", features: [aoi] }
        : { type: "FeatureCollection", features: [] }
    );

    void refreshSelection(map, currentTilesRef.current);
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
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource;

    const aoi = aoiRef.current;
    const selected = aoi ? intersectAoiWithTiles(aoi, tiles) : [];

    const marked = tiles.map((t) => ({
      ...t,
      properties: {
        ...t.properties,
        __selected: selected.some(
          (s) =>
            s.properties.tile_id === t.properties.tile_id &&
            s.properties.product === t.properties.product
        ),
      },
    }));

    currentTilesRef.current = marked;

    src.setData({
      type: "FeatureCollection",
      features: marked,
    });

    onSelectionChangeRef.current(selected);
  }

  function setTilesOnMap(map: Map, features: TileFeature[]) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource;

    currentTilesRef.current = features;

    src.setData({
      type: "FeatureCollection",
      features,
    });
  }

  return <div ref={containerRef} className="map" />;
}