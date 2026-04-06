import { useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

import { importAoiFromFile } from "./aoi/importAoi";
import { validateAoi } from "./aoi/validate";
import { exportBundle } from "./export/exportBundle";

type AvailableYears = {
  lidar: string[];
  mnt: string[];
};

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi, setAoi] = useState<AoiFeature | null>(null);

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

  const [loadingAoi, setLoadingAoi] = useState(false);

  async function handleAoiFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingAoi(true);
      const geo = await importAoiFromFile(file);
      const valid = validateAoi(geo);
      setAoi(valid);
    } catch (err: any) {
      alert(err?.message ?? "Erreur lors du chargement AOI");
    } finally {
      setLoadingAoi(false);
      e.target.value = "";
    }
  }

  const clearAoi = () => {
    setAoi(null);
    setSelectedTiles([]);
  };

  const lidarCount = selectedTiles.filter(
    (t) => String(t.properties?.product ?? "").toLowerCase() === "lidar"
  ).length;

  const mntCount = selectedTiles.filter(
    (t) => String(t.properties?.product ?? "").toLowerCase() === "mnt"
  ).length;

  const clearSelection = () => {
    setSelectedTiles([]);
  };

  async function handleExport() {
    await exportBundle({
      aoi,
      tiles: selectedTiles,
    });
  }

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

        <label>
          <input
            type="radiobutton"
            checked={showLidar}
            onChange={(e) => setShowLidar(e.target.checked)}
          />{" "}
          LiDAR
        </label>

        <br />

        <label>
          <input
            type="radiobutton"
            checked={showMnt}
            onChange={(e) => setShowMnt(e.target.checked)}
          />{" "}
          MNT
        </label>

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
            style={{ width: "100%" }}
          >
            <option value="ALL">Toutes</option>
            {availableYears.lidar.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
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
            style={{ width: "100%" }}
          >
            <option value="ALL">Toutes</option>
            {availableYears.mnt.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <h3 style={{ marginTop: 16 }}>Télécharger la zone d'étude</h3>

        <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
          Formats : GeoJSON, KML, KMZ, Shapefile (.zip).
        </div>

        <input type="file" onChange={handleAoiFile} />

        {loadingAoi && <div style={{ marginTop: 8 }}>Chargement AOI...</div>}

        {aoi && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "green", fontSize: 12, marginBottom: 6 }}>
              AOI chargée ✓
            </div>

            <button type="button" onClick={clearAoi}>
              Effacer la zone d’étude
            </button>
          </div>
        )}

        {!aoi && !loadingAoi && (
          <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
            Charge une AOI pour activer la sélection.
          </div>
        )}

        <h3 style={{ marginTop: 16 }}>Sélection</h3>

        <div>Total: {selectedTiles.length}</div>
        <div>LiDAR: {lidarCount}</div>
        <div>MNT: {mntCount}</div>

        <button
          onClick={handleExport}
          disabled={!aoi || selectedTiles.length === 0}
          style={{ marginTop: 8 }}
        >
          Exporter (ZIP)
        </button>

        <button onClick={clearSelection} style={{ marginTop: 4 }}>
          Vider la sélection
        </button>

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