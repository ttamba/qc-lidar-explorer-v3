import { useMemo, useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

import { importAoiFromFile } from "./aoi/importAoi";
import { validateAoi } from "./aoi/validate";
import {
  SUPPORTED_SOURCE_CRS,
  reprojectGeoJsonToWgs84,
  type SupportedSourceCrsCode,
} from "./aoi/reprojectAoi";
import { exportBundle } from "./export/exportBundle";

type Dataset = "lidar" | "mnt";

type AvailableYears = {
  lidar: string[];
  mnt: string[];
};

type YearFilter = {
  lidar: string | "ALL";
  mnt: string | "ALL";
};

function getTileProduct(tile: TileFeature): Dataset | "" {
  const props = (tile?.properties ?? {}) as Record<string, unknown>;

  const raw =
    props.normalized_product ??
    props.product ??
    props.PRODUIT ??
    props.type_produit ??
    "";

  const value = String(raw).toLowerCase();

  if (value === "lidar") return "lidar";
  if (value === "mnt") return "mnt";
  return "";
}

function isWgs84ValidationError(message: string): boolean {
  return /WGS84|EPSG:4326/i.test(message);
}

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi, setAoi] = useState<AoiFeature | null>(null);
  const [aoiError, setAoiError] = useState<string>("");

  const [pendingAoiRaw, setPendingAoiRaw] = useState<any | null>(null);
  const [pendingAoiFileName, setPendingAoiFileName] = useState<string>("");
  const [selectedSourceCrs, setSelectedSourceCrs] =
    useState<SupportedSourceCrsCode>("EPSG:32188");
  const [isReprojectingAoi, setIsReprojectingAoi] = useState(false);

  const [selectedProduct, setSelectedProduct] = useState<Dataset>("lidar");

  const [yearFilter, setYearFilter] = useState<YearFilter>({
    lidar: "ALL",
    mnt: "ALL",
  });

  const [availableYears, setAvailableYears] = useState<AvailableYears>({
    lidar: [],
    mnt: [],
  });

  const [loadingAoi, setLoadingAoi] = useState(false);

  const activeYears =
    selectedProduct === "lidar" ? availableYears.lidar : availableYears.mnt;

  const activeYear =
    selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;

  const activeSelectionCount = useMemo(() => {
    return selectedTiles.filter((tile) => getTileProduct(tile) === selectedProduct)
      .length;
  }, [selectedProduct, selectedTiles]);

  const lidarCount = useMemo(() => {
    return selectedTiles.filter((tile) => getTileProduct(tile) === "lidar").length;
  }, [selectedTiles]);

  const mntCount = useMemo(() => {
    return selectedTiles.filter((tile) => getTileProduct(tile) === "mnt").length;
  }, [selectedTiles]);

  async function handleAoiFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingAoi(true);
      setAoiError("");
      setPendingAoiRaw(null);
      setPendingAoiFileName("");

      const geo = await importAoiFromFile(file);

      try {
        const valid = validateAoi(geo);
        setAoi(valid);
        setSelectedTiles([]);
        return;
      } catch (validationError: any) {
        const message = validationError?.message ?? "Erreur lors du chargement AOI";

        if (isWgs84ValidationError(message)) {
          setAoi(null);
          setSelectedTiles([]);
          setPendingAoiRaw(geo);
          setPendingAoiFileName(file.name);
          setAoiError(
            `${message}\n\nLe fichier semble projeté. Choisissez le CRS source ci-dessous pour tenter une reprojection automatique vers WGS84.`
          );
          return;
        }

        throw validationError;
      }
    } catch (err: any) {
      setAoi(null);
      setSelectedTiles([]);
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setAoiError(err?.message ?? "Erreur lors du chargement AOI");
    } finally {
      setLoadingAoi(false);
      e.target.value = "";
    }
  }

  async function handleReprojectAndLoadAoi() {
    if (!pendingAoiRaw) return;

    try {
      setIsReprojectingAoi(true);
      setAoiError("");

      const reprojected = reprojectGeoJsonToWgs84(
        pendingAoiRaw,
        selectedSourceCrs
      );
      const valid = validateAoi(reprojected);

      setAoi(valid);
      setSelectedTiles([]);
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setAoiError("");
    } catch (err: any) {
      setAoi(null);
      setSelectedTiles([]);
      setAoiError(
        err?.message ??
          "La reprojection automatique a échoué. Vérifiez le CRS source choisi."
      );
    } finally {
      setIsReprojectingAoi(false);
    }
  }

  function clearAoi() {
    setAoi(null);
    setSelectedTiles([]);
    setAoiError("");
    setPendingAoiRaw(null);
    setPendingAoiFileName("");
  }

  function clearSelection() {
    setSelectedTiles([]);
  }

  function handleSelectedProductChange(product: Dataset) {
    setSelectedProduct(product);
    setSelectedTiles([]);
  }

  function handleYearChange(value: string) {
    setYearFilter((prev) => ({
      ...prev,
      [selectedProduct]: value as YearFilter[Dataset],
    }));
    setSelectedTiles([]);
  }

  function handleYearsChange(years: AvailableYears) {
    setAvailableYears(years);

    const nextYears = selectedProduct === "lidar" ? years.lidar : years.mnt;
    const currentYear =
      selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;

    if (currentYear !== "ALL" && !nextYears.includes(currentYear)) {
      setYearFilter((prev) => ({
        ...prev,
        [selectedProduct]: "ALL",
      }));
    }
  }

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
          background: "#f7f7f7",
        }}
      >
        <h3>Filtres</h3>

        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Produit</div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="selected-product"
              checked={selectedProduct === "lidar"}
              onChange={() => handleSelectedProductChange("lidar")}
            />
            LiDAR
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="selected-product"
              checked={selectedProduct === "mnt"}
              onChange={() => handleSelectedProductChange("mnt")}
            />
            MNT
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {selectedProduct === "lidar" ? "LiDAR" : "MNT"} — année
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="selected-year"
              checked={activeYear === "ALL"}
              onChange={() => handleYearChange("ALL")}
            />
            Toutes les années
          </label>

          {activeYears.map((year) => (
            <label
              key={year}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="selected-year"
                checked={activeYear === year}
                onChange={() => handleYearChange(year)}
              />
              {year}
            </label>
          ))}

          {activeYears.length === 0 && (
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              Aucune année disponible pour le produit actif dans la vue courante.
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 16,
            padding: 10,
            border: "1px solid #d1d5db",
            borderRadius: 10,
            background: "#f3f4f6",
            fontSize: 12,
            lineHeight: 1.5,
            color: "#374151",
          }}
        >
          <div>
            <strong>Produit actif :</strong> {selectedProduct.toUpperCase()}
          </div>
          <div>
            <strong>Année active :</strong>{" "}
            {activeYear === "ALL" ? "Toutes" : activeYear}
          </div>
          <div>
            <strong>Tuiles sélectionnées ({selectedProduct.toUpperCase()}) :</strong>{" "}
            {activeSelectionCount}
          </div>
        </div>

        <h3 style={{ marginTop: 16 }}>Charger la zone d'étude</h3>

        <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
          Formats : GeoJSON, KML, KMZ, Shapefile (.zip).
        </div>

        <input type="file" onChange={handleAoiFile} />

        {loadingAoi && <div style={{ marginTop: 8 }}>Chargement AOI...</div>}

        {aoiError && (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              border: "1px solid #ef4444",
              background: "#fef2f2",
              color: "#991b1b",
              fontSize: 12,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {aoiError}
          </div>
        )}

        {pendingAoiRaw && (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              border: "1px solid #f59e0b",
              background: "#fffbeb",
              color: "#92400e",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Reprojection assistée
            </div>

            {pendingAoiFileName && (
              <div style={{ marginBottom: 8 }}>
                <strong>Fichier :</strong> {pendingAoiFileName}
              </div>
            )}

            <label style={{ display: "block", marginBottom: 6 }}>
              CRS source
            </label>

            <select
              value={selectedSourceCrs}
              onChange={(e) =>
                setSelectedSourceCrs(
                  e.target.value as SupportedSourceCrsCode
                )
              }
              style={{ width: "100%", marginBottom: 8 }}
              disabled={isReprojectingAoi}
            >
              {SUPPORTED_SOURCE_CRS.map((crs) => (
                <option key={crs.code} value={crs.code}>
                  {crs.code} — {crs.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleReprojectAndLoadAoi}
              disabled={isReprojectingAoi}
            >
              {isReprojectingAoi ? "Reprojection..." : "Reprojeter et charger"}
            </button>

            <div style={{ marginTop: 8 }}>
              La reprojection cible toujours <strong>WGS84 (EPSG:4326)</strong>.
            </div>
          </div>
        )}

        {aoi && !aoiError && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "green", fontSize: 12, marginBottom: 6 }}>
              AOI chargée ✓
            </div>

            <button type="button" onClick={clearAoi}>
              Effacer la zone d’étude
            </button>
          </div>
        )}

        {!aoi && !loadingAoi && !aoiError && !pendingAoiRaw && (
          <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
            Charge une AOI pour activer la sélection.
          </div>
        )}

        <h3 style={{ marginTop: 16 }}>Sélection</h3>

        <div>Total: {selectedTiles.length}</div>
        <div>LiDAR: {lidarCount}</div>
        <div>MNT: {mntCount}</div>

        <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={handleExport}
            disabled={!aoi || selectedTiles.length === 0}
          >
            Exporter (ZIP)
          </button>

          <button onClick={clearSelection}>Vider la sélection</button>
        </div>

        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
          Le produit actif contrôle l’affichage et le filtre annuel.
        </div>

        <h3 style={{ marginTop: 16 }}>Panier</h3>
        <Basket tiles={selectedTiles} />
      </div>

      <div style={{ flex: 1 }}>
        <MapView
          aoi={aoi}
          basemaps={null}
          selectedProduct={selectedProduct}
          yearFilter={yearFilter}
          onYearsChange={handleYearsChange}
          onSelectionChange={setSelectedTiles}
        />
      </div>
    </div>
  );
}
