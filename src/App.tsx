import { useMemo, useState } from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

import { importAoiFromFile } from "./aoi/importAoi";
import { validateAoi } from "./aoi/validate";
import {
  SUPPORTED_SOURCE_CRS,
  autoDetectSourceCrsFromGeoJson,
  reprojectGeoJsonToWgs84,
  type SupportedSourceCrsCode,
} from "./aoi/reprojectAoi";
import { exportBundle } from "./export/exportBundle";

type Dataset = "lidar" | "mnt";
type AvailableYears = { lidar: string[]; mnt: string[] };
type YearFilter = { lidar: string | "ALL"; mnt: string | "ALL" };
type StatusTone = "info" | "success" | "warning" | "error";

/**
 * Déduit le produit d'une tuile pour compter proprement LiDAR vs MNT.
 */
function getTileProduct(tile: TileFeature): Dataset | "" {
  const props = (tile?.properties ?? {}) as Record<string, unknown>;
  const raw =
    props.normalized_product ?? props.product ?? props.PRODUIT ?? props.type_produit ?? "";
  const value = String(raw).toLowerCase();
  if (value === "lidar") return "lidar";
  if (value === "mnt") return "mnt";
  return "";
}

/**
 * Détecte si l'erreur de validation indique un problème de projection.
 */
function isWgs84ValidationError(message: string): boolean {
  return /WGS84|EPSG:4326/i.test(message);
}

/**
 * Style visuel unifié pour les cartes de statut.
 */
function getStatusCardStyle(tone: StatusTone): React.CSSProperties {
  switch (tone) {
    case "success":
      return {
        border: "1px solid #86efac",
        background: "#f0fdf4",
        color: "#166534",
      };
    case "warning":
      return {
        border: "1px solid #fcd34d",
        background: "#fffbeb",
        color: "#92400e",
      };
    case "error":
      return {
        border: "1px solid #fca5a5",
        background: "#fef2f2",
        color: "#991b1b",
      };
    case "info":
    default:
      return {
        border: "1px solid #bfdbfe",
        background: "#eff6ff",
        color: "#1d4ed8",
      };
  }
}

/**
 * Conteneur visuel générique pour les grandes sections du panneau latéral.
 */
function SectionCard(props: {
  title: string;
  children: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <section
      style={{
        marginTop: 14,
        padding: 14,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#ffffff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{props.title}</div>
        {props.subtitle && (
          <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
            {props.subtitle}
          </div>
        )}
      </div>
      {props.children}
    </section>
  );
}

/**
 * Carte de message utilisateur : info, succès, alerte ou erreur.
 */
function StatusCard(props: {
  tone: StatusTone;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 10,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        ...getStatusCardStyle(props.tone),
      }}
    >
      {props.children}
    </div>
  );
}

/**
 * Petit indicateur chiffré pour afficher les stats principales.
 */
function SmallStat(props: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 10,
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
      }}
    >
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{props.label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{props.value}</div>
    </div>
  );
}

/**
 * Bouton standardisé pour harmoniser les actions du panneau.
 */
function ActionButton(props: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit" | "reset";
}) {
  const variant = props.variant ?? "secondary";

  let style: React.CSSProperties = {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    cursor: props.disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
    fontSize: 13,
    opacity: props.disabled ? 0.6 : 1,
  };

  if (variant === "primary") {
    style = {
      ...style,
      border: "1px solid #2563eb",
      background: "#2563eb",
      color: "#ffffff",
    };
  }

  if (variant === "danger") {
    style = {
      ...style,
      border: "1px solid #dc2626",
      background: "#ffffff",
      color: "#b91c1c",
    };
  }

  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      style={style}
    >
      {props.children}
    </button>
  );
}

export default function App() {
  /**
   * États métier principaux :
   * AOI, sélection cartographique, filtres et années disponibles.
   */
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi, setAoi] = useState<AoiFeature | null>(null);
  const [aoiError, setAoiError] = useState<string>("");

  /**
   * États de reprojection assistée :
   * on stocke temporairement l'AOI brute lorsqu'un CRS source doit être choisi.
   */
  const [pendingAoiRaw, setPendingAoiRaw] = useState<any | null>(null);
  const [pendingAoiFileName, setPendingAoiFileName] = useState<string>("");
  const [selectedSourceCrs, setSelectedSourceCrs] =
    useState<SupportedSourceCrsCode>("EPSG:32188");
  const [detectedSourceCrs, setDetectedSourceCrs] =
    useState<SupportedSourceCrsCode | null>(null);
  const [isReprojectingAoi, setIsReprojectingAoi] = useState(false);

  /**
   * États d'interface :
   * produit actif, année active, années disponibles et états de travail.
   */
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
  const [isExporting, setIsExporting] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string>("");

  /**
   * Valeurs dérivées du produit actif pour simplifier le rendu UI.
   */
  const activeYears =
    selectedProduct === "lidar" ? availableYears.lidar : availableYears.mnt;
  const activeYear =
    selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;

  /**
   * Compteurs de sélection pour afficher un résumé clair à l'utilisateur.
   */
  const activeSelectionCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === selectedProduct).length,
    [selectedProduct, selectedTiles]
  );

  const lidarCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === "lidar").length,
    [selectedTiles]
  );

  const mntCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === "mnt").length,
    [selectedTiles]
  );

  const totalSelectionCount = selectedTiles.length;
  const hasAoi = Boolean(aoi);
  const hasPendingReprojection = Boolean(pendingAoiRaw);
  const isBusy = loadingAoi || isReprojectingAoi || isExporting;
  const canExport = hasAoi && totalSelectionCount > 0 && !isBusy;
  const canClearAoi = (hasAoi || hasPendingReprojection || !!aoiError) && !isBusy;
  const canClearSelection = totalSelectionCount > 0 && !isBusy;

  /**
   * Résumé d'état global affiché en haut du panneau :
   * activité en cours, erreur, succès ou état d'attente.
   */
  const statusSummary = useMemo(() => {
    if (loadingAoi) {
      return {
        tone: "info" as StatusTone,
        message: "Chargement de la zone d’étude en cours…",
      };
    }

    if (isReprojectingAoi) {
      return {
        tone: "info" as StatusTone,
        message: "Reprojection automatique de l’AOI en cours…",
      };
    }

    if (isExporting) {
      return {
        tone: "info" as StatusTone,
        message: "Préparation du bundle d’export en cours…",
      };
    }

    if (aoiError) {
      return {
        tone: "error" as StatusTone,
        message: aoiError,
      };
    }

    if (hasPendingReprojection) {
      return {
        tone: "warning" as StatusTone,
        message:
          "Une AOI projetée a été détectée. Vérifiez le CRS source puis lancez la reprojection vers WGS84.",
      };
    }

    if (infoMessage) {
      return {
        tone: "success" as StatusTone,
        message: infoMessage,
      };
    }

    if (hasAoi) {
      return {
        tone: "success" as StatusTone,
        message: "AOI chargée et prête pour l’exploration.",
      };
    }

    return {
      tone: "info" as StatusTone,
      message:
        "Importez une AOI pour activer la sélection, les filtres annuels et l’export.",
    };
  }, [
    aoiError,
    hasAoi,
    hasPendingReprojection,
    infoMessage,
    isExporting,
    isReprojectingAoi,
    loadingAoi,
  ]);

  /**
   * Importe un fichier AOI, tente une validation directe,
   * puis bascule en mode reprojection assistée si nécessaire.
   */
  async function handleAoiFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingAoi(true);
      setInfoMessage("");
      setAoiError("");
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);

      const geo = await importAoiFromFile(file);

      try {
        const valid = validateAoi(geo);
        setAoi(valid);
        setSelectedTiles([]);
        setAvailableYears({ lidar: [], mnt: [] });
        setInfoMessage(`AOI chargée avec succès : ${file.name}`);
        return;
      } catch (validationError: any) {
        const message = validationError?.message ?? "Erreur lors du chargement AOI";

        if (isWgs84ValidationError(message)) {
          const detected = autoDetectSourceCrsFromGeoJson(geo);
          setAoi(null);
          setSelectedTiles([]);
          setAvailableYears({ lidar: [], mnt: [] });
          setPendingAoiRaw(geo);
          setPendingAoiFileName(file.name);
          setDetectedSourceCrs(detected);
          setSelectedSourceCrs(detected ?? "EPSG:32188");
          setAoiError(
            detected
              ? `${message}\n\nCRS suggéré automatiquement : ${detected}. Vérifiez au besoin puis lancez la reprojection vers WGS84.`
              : `${message}\n\nLe fichier semble projeté. Choisissez le CRS source ci-dessous pour tenter une reprojection automatique vers WGS84.`
          );
          return;
        }

        throw validationError;
      }
    } catch (err: any) {
      setAoi(null);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);
      setInfoMessage("");
      setAoiError(err?.message ?? "Erreur lors du chargement AOI");
    } finally {
      setLoadingAoi(false);
      e.target.value = "";
    }
  }

  /**
   * Reprojette l'AOI en attente vers WGS84,
   * puis valide et charge le résultat final.
   */
  async function handleReprojectAndLoadAoi() {
    if (!pendingAoiRaw || isReprojectingAoi) return;

    try {
      setIsReprojectingAoi(true);
      setInfoMessage("");
      setAoiError("");

      const reprojected = reprojectGeoJsonToWgs84(pendingAoiRaw, selectedSourceCrs);
      const valid = validateAoi(reprojected);

      setAoi(valid);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);
      setAoiError("");
      setInfoMessage("AOI reprojetée et chargée avec succès.");
    } catch (err: any) {
      setAoi(null);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setInfoMessage("");
      setAoiError(
        err?.message ??
          "La reprojection automatique a échoué. Vérifiez le CRS source choisi."
      );
    } finally {
      setIsReprojectingAoi(false);
    }
  }

  /**
   * Réinitialise complètement le contexte AOI et la sélection.
   */
  function clearAoi() {
    setAoi(null);
    setSelectedTiles([]);
    setAvailableYears({ lidar: [], mnt: [] });
    setAoiError("");
    setInfoMessage("");
    setPendingAoiRaw(null);
    setPendingAoiFileName("");
    setDetectedSourceCrs(null);
  }

  /**
   * Vide uniquement la sélection cartographique courante.
   */
  function clearSelection() {
    setSelectedTiles([]);
    setInfoMessage("Sélection vidée.");
  }

  /**
   * Change le produit actif et remet la sélection à zéro
   * pour éviter les incohérences entre LiDAR et MNT.
   */
  function handleSelectedProductChange(product: Dataset) {
    setSelectedProduct(product);
    setSelectedTiles([]);
    setInfoMessage("");
  }

  /**
   * Applique un filtre annuel sur le produit actif.
   */
  function handleYearChange(value: string) {
    setYearFilter((prev) => ({
      ...prev,
      [selectedProduct]: value as YearFilter[Dataset],
    }));
    setSelectedTiles([]);
    setInfoMessage("");
  }

  /**
   * Met à jour les années disponibles remontées par la carte
   * et corrige le filtre courant si l'année n'existe plus.
   */
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

  /**
   * Exporte le bundle ZIP à partir de l'AOI et des tuiles sélectionnées.
   */
  async function handleExport() {
    if (!canExport) return;

    try {
      setIsExporting(true);
      setInfoMessage("");
      await exportBundle({ aoi, tiles: selectedTiles });
      setInfoMessage("Export ZIP généré avec succès.");
    } catch (err: any) {
      setAoiError(err?.message ?? "Erreur lors de la création du bundle d’export.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f3f4f6" }}>
      {/* Panneau latéral : contrôle utilisateur, statut, filtres et panier */}
      <aside
        style={{
          width: 360,
          padding: 14,
          borderRight: "1px solid #d1d5db",
          overflowY: "auto",
          background: "#f9fafb",
        }}
      >
        {/* En-tête applicatif + résumé de statut */}
        <div
          style={{
            padding: 14,
            borderRadius: 14,
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 19, fontWeight: 800, color: "#111827", marginBottom: 4 }}>
            QC LiDAR / MNT Explorer
          </div>
          <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.45 }}>
            Exploration, sélection et export de tuiles LiDAR et MNT à partir d’une zone d’étude.
          </div>

          <StatusCard tone={statusSummary.tone}>{statusSummary.message}</StatusCard>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <SmallStat label="Produit actif" value={selectedProduct.toUpperCase()} />
            <SmallStat label="Année active" value={activeYear === "ALL" ? "Toutes" : activeYear} />
            <SmallStat label="Sélection active" value={activeSelectionCount} />
            <SmallStat label="Total sélectionné" value={totalSelectionCount} />
          </div>
        </div>

        {/* Chargement AOI + gestion de la reprojection assistée */}
        <SectionCard
          title="Zone d’étude"
          subtitle="Formats pris en charge : GeoJSON, KML, KMZ et Shapefile ZIP."
        >
          <input
            type="file"
            onChange={handleAoiFile}
            disabled={isBusy}
            style={{ width: "100%" }}
          />

          {pendingAoiRaw && (
            <StatusCard tone="warning">
              Une reprojection assistée est requise avant chargement.
            </StatusCard>
          )}

          {pendingAoiRaw && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 10,
                border: "1px solid #fcd34d",
                background: "#fffbeb",
                color: "#92400e",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Reprojection assistée</div>

              {pendingAoiFileName && (
                <div style={{ marginBottom: 8 }}>
                  <strong>Fichier :</strong> {pendingAoiFileName}
                </div>
              )}

              {detectedSourceCrs && (
                <div
                  style={{
                    marginBottom: 8,
                    padding: 8,
                    borderRadius: 8,
                    background: "#ecfccb",
                    border: "1px solid #84cc16",
                    color: "#365314",
                  }}
                >
                  <strong>CRS suggéré :</strong> {detectedSourceCrs}
                </div>
              )}

              <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                CRS source
              </label>

              <select
                value={selectedSourceCrs}
                onChange={(e) => setSelectedSourceCrs(e.target.value as SupportedSourceCrsCode)}
                style={{
                  width: "100%",
                  marginBottom: 10,
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                }}
                disabled={isReprojectingAoi}
              >
                {SUPPORTED_SOURCE_CRS.map((crs) => (
                  <option key={crs.code} value={crs.code}>
                    {crs.code} — {crs.label}
                  </option>
                ))}
              </select>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <ActionButton
                  onClick={handleReprojectAndLoadAoi}
                  disabled={isReprojectingAoi}
                  variant="primary"
                >
                  {isReprojectingAoi ? "Reprojection..." : "Reprojeter et charger"}
                </ActionButton>

                <ActionButton
                  onClick={clearAoi}
                  disabled={isBusy}
                  variant="secondary"
                >
                  Annuler
                </ActionButton>
              </div>

              <div style={{ marginTop: 8 }}>
                La reprojection cible toujours <strong>WGS84 (EPSG:4326)</strong>.
              </div>
            </div>
          )}

          {!pendingAoiRaw && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ActionButton
                onClick={clearAoi}
                disabled={!canClearAoi}
                variant="danger"
              >
                Effacer la zone d’étude
              </ActionButton>
            </div>
          )}

          {!hasAoi && !loadingAoi && !aoiError && !pendingAoiRaw && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
              Aucune AOI chargée pour le moment.
            </div>
          )}

          {hasAoi && !aoiError && !pendingAoiRaw && (
            <StatusCard tone="success">Zone d’étude chargée et validée.</StatusCard>
          )}
        </SectionCard>

        {/* Filtres métier : produit actif et année disponible */}
        <SectionCard
          title="Filtres"
          subtitle="Le produit actif contrôle l’affichage cartographique et le filtre annuel."
        >
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#111827" }}>Produit</div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                cursor: isBusy ? "not-allowed" : "pointer",
                color: "#111827",
              }}
            >
              <input
                type="radio"
                name="selected-product"
                checked={selectedProduct === "lidar"}
                onChange={() => handleSelectedProductChange("lidar")}
                disabled={isBusy}
              />
              LiDAR
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: isBusy ? "not-allowed" : "pointer",
                color: "#111827",
              }}
            >
              <input
                type="radio"
                name="selected-product"
                checked={selectedProduct === "mnt"}
                onChange={() => handleSelectedProductChange("mnt")}
                disabled={isBusy}
              />
              MNT
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#111827" }}>
              {selectedProduct === "lidar" ? "LiDAR" : "MNT"} — année
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                cursor: isBusy ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="radio"
                name="selected-year"
                checked={activeYear === "ALL"}
                onChange={() => handleYearChange("ALL")}
                disabled={isBusy}
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
                  cursor: isBusy ? "not-allowed" : "pointer",
                }}
              >
                <input
                  type="radio"
                  name="selected-year"
                  checked={activeYear === year}
                  onChange={() => handleYearChange(year)}
                  disabled={isBusy}
                />
                {year}
              </label>
            ))}

            {activeYears.length === 0 && (
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
                Aucune année disponible pour le produit actif dans la vue courante.
              </div>
            )}
          </div>
        </SectionCard>

        {/* Résumé de la sélection et actions d'export */}
        <SectionCard
          title="Sélection"
          subtitle="Les tuiles sélectionnées sur la carte alimentent directement l’export."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <SmallStat label="Total" value={totalSelectionCount} />
            <SmallStat label="LiDAR" value={lidarCount} />
            <SmallStat label="MNT" value={mntCount} />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ActionButton
              onClick={handleExport}
              disabled={!canExport}
              variant="primary"
            >
              {isExporting ? "Export..." : "Exporter (ZIP)"}
            </ActionButton>

            <ActionButton
              onClick={clearSelection}
              disabled={!canClearSelection}
              variant="secondary"
            >
              Vider la sélection
            </ActionButton>
          </div>

          {!hasAoi && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
              Chargez d’abord une AOI pour activer une sélection exploitable.
            </div>
          )}

          {hasAoi && totalSelectionCount === 0 && !isBusy && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
              Aucune tuile sélectionnée actuellement pour les filtres actifs.
            </div>
          )}
        </SectionCard>

        {/* Panier : liste détaillée des tuiles retenues */}
        <SectionCard
          title="Panier"
          subtitle="Résumé des tuiles retenues pour l’export."
        >
          <Basket tiles={selectedTiles} />
        </SectionCard>
      </aside>

      {/* Zone principale : rendu cartographique et interactions sur la carte */}
      <main style={{ flex: 1, minWidth: 0 }}>
        <MapView
          aoi={aoi}
          basemaps={null}
          selectedProduct={selectedProduct}
          yearFilter={yearFilter}
          onYearsChange={handleYearsChange}
          onSelectionChange={setSelectedTiles}
        />
      </main>
    </div>
  );
}