import { useMemo, useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

import { importAoiFromFile } from "./aoi/importAoi";
import { validateAoi } from "./aoi/validate";
import { exportBundle } from "./export/exportBundle";

type Dataset = "lidar" | "mnt";

type AvailableYears = {
  lidar: string[];
  mnt: string[];
};

function getTileDataset(tile: TileFeature): Dataset | "" {
  const rawValue =
    tile.properties?.normalized_product ??
    tile.properties?.product ??
    tile.properties?.__dataset ??
    "";

  const value = String(rawValue).toLowerCase();
  return value === "lidar" || value === "mnt" ? value : "";
}

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi, setAoi] = useState<AoiFeature | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Dataset>("lidar");

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

  const clearSelection = () => {
    setSelectedTiles([]);
  };

  async function handleExport() {
    await exportBundle({
      aoi,
      tiles: selectedTiles,
    });
  }

  const lidarCount = useMemo(
    () => selectedTiles.filter((tile) => getTileDataset(tile) === "lidar").length,
    [selectedTiles]
  );

  const mntCount = useMemo(
    () => selectedTiles.filter((tile) => getTileDataset(tile) === "mnt").length,
    [selectedTiles]
  );

  const activeYears = selectedProduct === "lidar" ? availableYears.lidar : availableYears.mnt;
  const activeYear = selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;
  const activeCount = selectedProduct === "lidar" ? lidarCount : mntCount;

  function setActiveYear(nextYear: string | "ALL") {
    setYearFilter((prev) =>
      selectedProduct === "lidar"
        ? { ...prev, lidar: nextYear }
        : { ...prev, mnt: nextYear }
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div
        style={{
          width: 340,
          padding: 12,
          borderRight: "1px solid #ddd",
          overflowY: "auto",
          background: "#fff",
        }}
      >
        <h3>Filtres</h3>

        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: 8 }}>Produit</legend>

          <label style={{ display: "block", marginBottom: 6 }}>
            <input
              type="radio"
              name="selected-product"
              checked={selectedProduct === "lidar"}
              onChange={() => setSelectedProduct("lidar")}
            />{" "}
            LiDAR
          </label>

          <label style={{ display: "block" }}>
            <input
              type="radio"
              name="selected-product"
              checked={selectedProduct === "mnt"}
              onChange={() => setSelectedProduct("mnt")}
            />{" "}
            MNT
          </label>
        </fieldset>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {selectedProduct === "lidar" ? "LiDAR" : "MNT"} — année
          </div>

          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <label style={{ display: "block", marginBottom: 6 }}>
              <input
                type="radio"
                name={`year-filter-${selectedProduct}`}
                checked={activeYear === "ALL"}
                onChange={() => setActiveYear("ALL")}
              />{" "}
              Toutes les années
            </label>

            {activeYears.map((year) => (
              <label key={year} style={{ display: "block", marginBottom: 6 }}>
                <input
                  type="radio"
                  name={`year-filter-${selectedProduct}`}
                  checked={activeYear === year}
                  onChange={() => setActiveYear(year)}
                />{" "}
                {year}
              </label>
            ))}
          </fieldset>
        </div>

        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "#4b5563",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 10,
            lineHeight: 1.5,
          }}
        >
          <div>
            <strong>Produit actif :</strong> {selectedProduct.toUpperCase()}
          </div>
          <div>
            <strong>Année active :</strong> {activeYear === "ALL" ? "Toutes" : activeYear}
          </div>
          <div>
            <strong>Tuiles sélectionnées ({selectedProduct.toUpperCase()}) :</strong> {activeCount}
          </div>
        </div>

        <h3 style={{ marginTop: 16 }}>Charger la zone d'étude</h3>

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
        <div style={{ marginTop: 4, fontSize: 12, color: "#666" }}>
          Le produit actif contrôle l’affichage et le filtre annuel.
        </div>

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
          selectedProduct={selectedProduct}
          yearFilter={yearFilter}
          onYearsChange={setAvailableYears}
          onSelectionChange={setSelectedTiles}
        />
      </div>
    </div>
  );
}
