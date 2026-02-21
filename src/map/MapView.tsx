import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { AoiFeature, BasemapConfig, TileFeature, TileFC } from "../types";
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
const LYR_TILES_SELECTED = "tiles-selected-lyr";
const SRC_AOI = "aoi-src";
const LYR_AOI = "aoi-lyr";

export default function MapView(props: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map()); // chunkPath -> features

  const styleSpec = useMemo(() => {
    // style minimal : raster OSM depuis basemaps.json si dispo, sinon fallback
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
        { id: "osm", type: "raster", source: "osm" },
      ],
    } as any;
  }, [props.basemaps]);

  // init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleSpec,
      center: [-73.6, 45.5], // Montréal approx
      zoom: 8,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      // Tiles source/layers
      map.addSource(SRC_TILES, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: LYR_TILES,
        type: "line",
        source: SRC_TILES,
        paint: { "line-width": 1.5, "line-opacity": 0.6 },
      });

      map.addLayer({
        id: LYR_TILES_SELECTED,
        type: "fill",
        source: SRC_TILES,
        paint: { "fill-opacity": 0.35 },
        filter: ["==", ["get", "__selected"], true],
      });

      // AOI
      map.addSource(SRC_AOI, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: LYR_AOI,
        type: "line",
        source: SRC_AOI,
        paint: { "line-width": 2.5, "line-opacity": 0.9 },
      });

      // initial load tiles
      void refreshTiles(map);
    });

    // throttle moveend
    const onMoveEnd = () => void refreshTiles(map);
    map.on("moveend", onMoveEnd);

    mapRef.current = map;
    return () => {
      map.off("moveend", onMoveEnd);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleSpec]);

  // update style if basemap changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(styleSpec);
  }, [styleSpec]);

  // update AOI layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource(SRC_AOI) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const fc = props.aoi
      ? { type: "FeatureCollection", features: [props.aoi] }
      : { type: "FeatureCollection", features: [] };

    src.setData(fc as any);

    // recompute selection when AOI changes
    void refreshSelection(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.aoi]);

  // update product toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void refreshTiles(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showLidar, props.showMnt]);

  async function refreshTiles(map: Map) {
    if (!map.isStyleLoaded()) return;

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    // limiter: évite de charger à très petit zoom
    if (map.getZoom() < 7) {
      setTilesOnMap(map, []);
      props.onSelectionChange([]);
      return;
    }

    const features: TileFeature[] = [];

    if (props.showLidar) {
      const lidar = await loadTilesForBBox("lidar", bbox, cacheRef.current);
      features.push(...lidar);
    }
    if (props.showMnt) {
      const mnt = await loadTilesForBBox("mnt", bbox, cacheRef.current);
      features.push(...mnt);
    }

    setTilesOnMap(map, features);
    await refreshSelection(map);
  }

  async function refreshSelection(map: Map) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const current = (src as any)._data as TileFC | undefined;
    const tiles = (current?.features ?? []) as TileFeature[];

    const selected = props.aoi ? intersectAoiWithTiles(props.aoi, tiles) : [];

    // marquage pour style (fill sur sélection)
    const marked = tiles.map((t) => ({
      ...t,
      properties: { ...t.properties, __selected: selected.some((s) => s.properties.tile_id === t.properties.tile_id && s.properties.product === t.properties.product) },
    })) as any;

    src.setData({ type: "FeatureCollection", features: marked } as any);
    props.onSelectionChange(selected);
  }

  function setTilesOnMap(map: Map, features: TileFeature[]) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features } as any);
  }

  return <div ref={containerRef} className="map" />;
}
