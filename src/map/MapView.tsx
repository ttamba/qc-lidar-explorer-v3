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
  const cacheRef = useRef<globalThis.Map<string, TileFeature[]>>(new globalThis.Map());

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
        type: "line",
        source: SRC_TILES,
        paint: {
          "line-color": "#ff5500",
          "line-width": 2,
          "line-opacity": 0.9,
        },
      });
    }

    if (!map.getLayer(LYR_TILES_SELECTED)) {
      map.addLayer({
        id: LYR_TILES_SELECTED,
        type: "fill",
        source: SRC_TILES,
        paint: {
          "fill-color": "#ff5500",
          "fill-opacity": 0.25,
        },
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
        paint: {
          "line-color": "#0066ff",
          "line-width": 2.5,
          "line-opacity": 0.9,
        },
      });
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

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      ensureCustomSourcesAndLayers(map);
      void refreshTiles(map);
    });

    const onMoveEnd = () => void refreshTiles(map);
    map.on("moveend", onMoveEnd);

    mapRef.current = map;

    return () => {
      map.off("moveend", onMoveEnd);
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

    const src = map.getSource(SRC_AOI) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const fc = props.aoi
      ? { type: "FeatureCollection", features: [props.aoi] }
      : { type: "FeatureCollection", features: [] };

    src.setData(fc as any);
    void refreshSelection(map);
  }, [props.aoi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void refreshTiles(map);
  }, [props.showLidar, props.showMnt]);

  async function refreshTiles(map: Map) {
    if (!map.isStyleLoaded()) return;

    ensureCustomSourcesAndLayers(map);

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];

    const tiles: TileFeature[] = [];

    if (props.showLidar) {
      const lidar = await loadTilesForBBox("lidar", bbox, cacheRef.current);
      tiles.push(...lidar);
    }

    if (props.showMnt) {
      const mnt = await loadTilesForBBox("mnt", bbox, cacheRef.current);
      tiles.push(...mnt);
    }

    console.log("bbox =", bbox);
    console.log("tiles loaded =", tiles.length);

    setTilesOnMap(map, tiles);
    await refreshSelection(map);
  }

  async function refreshSelection(map: Map) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const current = (src as any)._data as TileFC | undefined;
    const tiles = (current?.features ?? []) as TileFeature[];

    const selected = props.aoi ? intersectAoiWithTiles(props.aoi, tiles) : [];

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
    })) as TileFeature[];

    src.setData({
      type: "FeatureCollection",
      features: marked,
    } as any);

    props.onSelectionChange(selected);
  }

  function setTilesOnMap(map: Map, features: TileFeature[]) {
    const src = map.getSource(SRC_TILES) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    src.setData({
      type: "FeatureCollection",
      features,
    } as any);
  }

  return <div ref={containerRef} className="map" />;
}