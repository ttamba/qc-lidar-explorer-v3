import { useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi] = useState<AoiFeature | null>(null);

  const [showLidar, setShowLidar] = useState(true);
  const [showMnt, setShowMnt] = useState(true);

  // ✅ FILTRE ANNÉE
  const [yearFilter, setYearFilter] = useState({
    lidar: "ALL",
    mnt: "ALL",
  });

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      
      {/* 🧭 PANEL GAUCHE */}
      <div style={{ width: 320, padding: 12, borderRight: "1px solid #ddd" }}>
        
        <h3>Filtres</h3>

        {/* Toggle couches */}
        <div>
          <label>
            <input
              type="checkbox"
              checked={showLidar}
              onChange={(e) => setShowLidar(e.target.checked)}
            />
            LiDAR
          </label>
        </div>

        <div>
          <label>
            <input
              type="checkbox"
              checked={showMnt}
              onChange={(e) => setShowMnt(e.target.checked)}
            />
            MNT
          </label>
        </div>

        {/* 🎯 FILTRE ANNÉE */}
        <div style={{ marginTop: 12 }}>
          <label>LiDAR année</label>
          <select
            value={yearFilter.lidar}
            onChange={(e) =>
              setYearFilter((prev) => ({
                ...prev,
                lidar: e.target.value,
              }))
            }
          >
            <option value="ALL">Toutes</option>
            <option value="2024">2024</option>
            <option value="2023">2023</option>
            <option value="2022">2022</option>
          </select>
        </div>

        <div style={{ marginTop: 8 }}>
          <label>MNT année</label>
          <select
            value={yearFilter.mnt}
            onChange={(e) =>
              setYearFilter((prev) => ({
                ...prev,
                mnt: e.target.value,
              }))
            }
          >
            <option value="ALL">Toutes</option>
            <option value="2024">2024</option>
            <option value="2023">2023</option>
            <option value="2022">2022</option>
          </select>
        </div>

        {/* 🧺 PANIER */}
        <h3 style={{ marginTop: 16 }}>Panier</h3>
        <Basket tiles={selectedTiles} />
      </div>

      {/* 🗺️ MAP */}
      <div style={{ flex: 1 }}>
        <MapView
          aoi={aoi}
          basemaps={null}
          showLidar={showLidar}
          showMnt={showMnt}
          yearFilter={yearFilter} // ✅ PROPAGATION
          onSelectionChange={setSelectedTiles}
        />
      </div>
    </div>
  );
}