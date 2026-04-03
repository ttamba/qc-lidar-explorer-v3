import { useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

type AvailableYears = {
  lidar: string[];
  mnt: string[];
};

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi] = useState<AoiFeature | null>(null);

  const [showLidar, setShowLidar] = useState(true);
  const [showMnt, setShowMnt] = useState(true);

  const [yearFilter, setYearFilter] = useState<{
    lidar: string | "ALL";
    mnt: string | "ALL";
  }>({
    lidar: "ALL",
    mnt: "ALL",
  });

  const [availableYears, setAvailableYears] = useState<AvailableYears>({
    lidar: [],
    mnt: [],
  });

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div
        style={{
          width: 320,
          padding: 12,
          borderRight: "1px solid #ddd",
          overflowY: "auto",
        }}
      >
        <h3>Filtres</h3>

        <div>
          <label>
            <input
              type="checkbox"
              checked={showLidar}
              onChange={(e) => setShowLidar(e.target.checked)}
            />{" "}
            LiDAR
          </label>
        </div>

        <div>
          <label>
            <input
              type="checkbox"
              checked={showMnt}
              onChange={(e) => setShowMnt(e.target.checked)}
            />{" "}
            MNT
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", marginBottom: 4 }}>
            LiDAR année
          </label>
          <select
            value={yearFilter.lidar}
            onChange={(e) =>
              setYearFilter((prev) => ({
                ...prev,
                lidar: e.target.value,
              }))
            }
            style={{ width: "100%" }}
          >
            <option value="ALL">Toutes</option>
            {availableYears.lidar.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 8 }}>
          <label style={{ display: "block", marginBottom: 4 }}>
            MNT année
          </label>
          <select
            value={yearFilter.mnt}
            onChange={(e) =>
              setYearFilter((prev) => ({
                ...prev,
                mnt: e.target.value,
              }))
            }
            style={{ width: "100%" }}
          >
            <option value="ALL">Toutes</option>
            {availableYears.mnt.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>

        <h3 style={{ marginTop: 16 }}>Panier</h3>
        <Basket tiles={selectedTiles} />
      </div>

      <div style={{ flex: 1 }}>
        <MapView
          aoi={aoi}
          basemaps={null}
          showLidar={showLidar}
          showMnt={showMnt}
          yearFilter={yearFilter}
          onYearsChange={setAvailableYears}
          onSelectionChange={setSelectedTiles}
        />
      </div>
    </div>
  );
}