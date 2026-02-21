import { useMemo, useState } from "react";
import MapView from "../map/MapView";
import LeftPanel from "../ui/LeftPanel";
import type { AoiFeature, TileFeature, BasemapConfig } from "../types";
import { exportBundle } from "../export/exportBundle";
import "./App.css";

export default function App() {
  const [basemaps, setBasemaps] = useState<BasemapConfig | null>(null);

  const [aoi, setAoi] = useState<AoiFeature | null>(null);
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);

  const [showLidar, setShowLidar] = useState(true);
  const [showMnt, setShowMnt] = useState(true);

  const selectionStats = useMemo(() => {
    const byProduct = selectedTiles.reduce(
      (acc, t) => {
        acc[t.properties.product] += 1;
        return acc;
      },
      { lidar: 0, mnt: 0 }
    );
    return {
      total: selectedTiles.length,
      ...byProduct,
    };
  }, [selectedTiles]);

  return (
    <div className="layout">
      <LeftPanel
        basemaps={basemaps}
        onBasemapsLoaded={setBasemaps}
        aoi={aoi}
        onAoiChange={setAoi}
        selectedTiles={selectedTiles}
        stats={selectionStats}
        showLidar={showLidar}
        showMnt={showMnt}
        onToggleLidar={setShowLidar}
        onToggleMnt={setShowMnt}
        onExport={() => exportBundle({ aoi, tiles: selectedTiles })}
        onClearSelection={() => setSelectedTiles([])}
      />

      <div className="mapWrap">
        <MapView
          basemaps={basemaps}
          aoi={aoi}
          showLidar={showLidar}
          showMnt={showMnt}
          onSelectionChange={setSelectedTiles}
        />
      </div>
    </div>
  );
}
