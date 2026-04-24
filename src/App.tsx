import { useMemo, useState } from "react";
import "./app/App.css";
import {
  checkLocalAgent,
  exportWithLocalAgent,
  type LocalAgentTile,
  type LocalExportResponse,
  type OutputMode,
  type PackageMode,
} from "./agent/localAgent";

/**
 * App.tsx consolidé — QC LiDAR / MNT Explorer
 *
 * Objectif de cette version :
 * - ajouter outputMode: "zip" | "folder"
 * - conserver packageMode: "lean" | "full"
 * - adapter la progression :
 *   - ZIP      : preparing -> downloading -> metadata -> zipping -> completed
 *   - Folder   : preparing -> downloading -> metadata -> completed
 * - afficher un statut final différent :
 *   - ZIP généré / téléchargé
 *   - Dossier prêt QGIS généré
 *
 * IMPORTANT :
 * Cette version est volontairement structurée pour être facile à fusionner avec votre App.tsx actuel.
 * Les variables selectedTiles, aoiGeoJson et MapView sont indiquées clairement dans la section
 * "INTÉGRATION AVEC VOTRE LOGIQUE EXISTANTE".
 */

type ExportStatus =
  | "idle"
  | "preparing"
  | "downloading"
  | "metadata"
  | "zipping"
  | "completed"
  | "error";

type AnyGeoJson = GeoJSON.FeatureCollection | GeoJSON.Feature | null;

type SelectedTileLike = {
  id?: string;
  url?: string;
  filename?: string;
  product?: string;
  year?: string | number;
  properties?: Record<string, any>;
};

function normalizeSelectedTile(tile: SelectedTileLike): LocalAgentTile {
  const properties = tile.properties ?? {};

  return {
    id: tile.id ?? properties.id ?? properties.ID ?? properties.tile_id ?? properties.tuile,
    url: tile.url ?? properties.url ?? properties.URL ?? properties.download_url ?? properties.href,
    filename:
      tile.filename ??
      properties.filename ??
      properties.file_name ??
      properties.nom_fichier ??
      properties.name,
    product: tile.product ?? properties.product ?? properties.produit ?? properties.type,
    year: tile.year ?? properties.year ?? properties.annee ?? properties.millesime,
    properties,
  };
}

function getProgressPercent(status: ExportStatus, outputMode: OutputMode): number {
  if (status === "idle") return 0;
  if (status === "preparing") return 10;
  if (status === "downloading") return 55;
  if (status === "metadata") return outputMode === "folder" ? 85 : 75;
  if (status === "zipping") return 90;
  if (status === "completed") return 100;
  if (status === "error") return 100;
  return 0;
}

function getProgressLabel(status: ExportStatus, outputMode: OutputMode): string {
  if (status === "idle") return "En attente";
  if (status === "preparing") return "Préparation de l’export local";
  if (status === "downloading") return "Téléchargement parallèle des tuiles";
  if (status === "metadata") return "Génération des métadonnées";
  if (status === "zipping") return "Création du ZIP";
  if (status === "completed") {
    return outputMode === "folder" ? "Dossier prêt QGIS généré" : "ZIP généré";
  }
  if (status === "error") return "Erreur pendant l’export";
  return "";
}

export default function App() {
  // ============================================================
  // STATES EXISTANTS À CONSERVER / FUSIONNER
  // ============================================================

  /**
   * À remplacer par vos states existants si ces variables existent déjà dans votre App.tsx.
   *
   * selectedTiles doit contenir les tuiles sélectionnées.
   * aoiGeoJson doit contenir l’AOI chargée/reprojetée.
   */
  const [selectedTiles] = useState<SelectedTileLike[]>([]);
  const [aoiGeoJson] = useState<AnyGeoJson>(null);

  // ============================================================
  // NOUVEAUX STATES EXPORT LOCAL V5
  // ============================================================

  const [packageMode, setPackageMode] = useState<PackageMode>("lean");
  const [outputMode, setOutputMode] = useState<OutputMode>("zip");

  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportMessage, setExportMessage] = useState<string>("");
  const [exportResult, setExportResult] = useState<LocalExportResponse | null>(null);
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const progressPercent = useMemo(
    () => getProgressPercent(exportStatus, outputMode),
    [exportStatus, outputMode]
  );

  const progressLabel = useMemo(
    () => getProgressLabel(exportStatus, outputMode),
    [exportStatus, outputMode]
  );

  const normalizedTiles = useMemo(
    () => selectedTiles.map((tile) => normalizeSelectedTile(tile)).filter((tile) => Boolean(tile.url)),
    [selectedTiles]
  );

  const canExport = normalizedTiles.length > 0 && !isExporting;

  // ============================================================
  // EXPORT LOCAL V5 — ZIP OU FOLDER
  // ============================================================

  async function handleLocalExport() {
    if (!normalizedTiles.length) {
      setExportStatus("error");
      setExportMessage("Aucune tuile sélectionnée pour l’export.");
      return;
    }

    try {
      setIsExporting(true);
      setExportResult(null);

      setExportStatus("preparing");
      setExportMessage("Vérification de l’agent local FastAPI...");

      const agentOk = await checkLocalAgent();
      if (!agentOk) {
        throw new Error("Agent local FastAPI non disponible sur http://127.0.0.1:8765");
      }

      setExportStatus("downloading");
      setExportMessage("Téléchargement parallèle des tuiles en cours...");

      const exportName = `qc_lidar_mnt_${outputMode}_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;

      const response = await exportWithLocalAgent({
        tiles: normalizedTiles,
        aoi: aoiGeoJson,
        selected_tiles_geojson: {
          type: "FeatureCollection",
          features: selectedTiles as GeoJSON.Feature[],
        },
        packageMode,
        outputMode,
        keep_downloaded_files: outputMode === "folder",
        include_debug_files: false,
        export_name: exportName,
      });

      setExportStatus("metadata");
      setExportMessage("Métadonnées générées : tile_metadata.json, tile_metadata.csv et logs.txt.");

      if (outputMode === "zip") {
        setExportStatus("zipping");
        setExportMessage("ZIP généré par l’agent local. Ouverture du téléchargement...");
      }

      setExportResult(response);
      setExportStatus("completed");

      if (outputMode === "zip") {
        setExportMessage(
          `ZIP généré avec succès : ${response.downloaded_count} tuile(s), ${response.failed_count} échec(s), durée ${response.elapsed_seconds}s.`
        );

        if (response.download_url) {
          window.open(response.download_url, "_blank", "noopener,noreferrer");
        }
      } else {
        setExportMessage(
          `Dossier prêt QGIS généré : ${response.folder_path ?? response.export_dir}`
        );
      }
    } catch (error) {
      setExportStatus("error");
      setExportMessage(error instanceof Error ? error.message : "Erreur inconnue pendant l’export.");
    } finally {
      setIsExporting(false);
    }
  }

  // ============================================================
  // UI
  // ============================================================

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>QC LiDAR / MNT Explorer</h1>
          <p>Export local optimisé — ZIP lean ou dossier prêt QGIS</p>
        </div>
      </header>

      <main className="app-layout">
        <section className="map-panel">
          {/*
            INTÉGRATION AVEC VOTRE LOGIQUE EXISTANTE

            Remplacez ce bloc par votre composant MapView actuel.
            Exemple :

            <MapView
              selectedTiles={selectedTiles}
              setSelectedTiles={setSelectedTiles}
              aoiGeoJson={aoiGeoJson}
              setAoiGeoJson={setAoiGeoJson}
              ...vos autres props existantes
            />
          */}
          <div className="map-placeholder">
            <strong>MapView existant à conserver ici</strong>
            <p>Nombre de tuiles sélectionnées : {selectedTiles.length}</p>
          </div>
        </section>

        <aside className="export-panel">
          <h2>Export local</h2>

          <div className="export-section">
            <h3>Mode de paquet</h3>

            <label className="radio-row">
              <input
                type="radio"
                name="packageMode"
                value="lean"
                checked={packageMode === "lean"}
                onChange={() => setPackageMode("lean")}
                disabled={isExporting}
              />
              <span>Lean — tuiles + métadonnées + logs</span>
            </label>

            <label className="radio-row">
              <input
                type="radio"
                name="packageMode"
                value="full"
                checked={packageMode === "full"}
                onChange={() => setPackageMode("full")}
                disabled={isExporting}
              />
              <span>Full — réservé aux exports complets/debug</span>
            </label>
          </div>

          <div className="export-section">
            <h3>Mode de sortie</h3>

            <label className="radio-row">
              <input
                type="radio"
                name="outputMode"
                value="zip"
                checked={outputMode === "zip"}
                onChange={() => setOutputMode("zip")}
                disabled={isExporting}
              />
              <span>ZIP lean</span>
            </label>

            <label className="radio-row">
              <input
                type="radio"
                name="outputMode"
                value="folder"
                checked={outputMode === "folder"}
                onChange={() => setOutputMode("folder")}
                disabled={isExporting}
              />
              <span>Dossier prêt QGIS</span>
            </label>
          </div>

          <div className="export-section export-summary">
            <p>
              <strong>Tuiles sélectionnées :</strong> {normalizedTiles.length}
            </p>
            <p>
              <strong>Sortie :</strong>{" "}
              {outputMode === "folder" ? "Dossier sans ZIP" : "Archive ZIP"}
            </p>
            <p>
              <strong>Livrable :</strong>{" "}
              {outputMode === "folder"
                ? "downloaded_tiles/ + tile_metadata.json + tile_metadata.csv + logs.txt"
                : "ZIP contenant les tuiles, métadonnées et logs"}
            </p>
          </div>

          <button
            type="button"
            className="export-button"
            onClick={handleLocalExport}
            disabled={!canExport}
          >
            {isExporting
              ? "Export en cours..."
              : outputMode === "folder"
                ? "Générer le dossier prêt QGIS"
                : "Générer le ZIP lean"}
          </button>

          <div className={`progress-card status-${exportStatus}`}>
            <div className="progress-header">
              <strong>{progressLabel}</strong>
              <span>{progressPercent}%</span>
            </div>

            <div className="progress-track">
              <div
                className="progress-bar"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {exportMessage && <p className="export-message">{exportMessage}</p>}
          </div>

          {exportResult && (
            <div className="export-result-card">
              {exportResult.outputMode === "zip" ? (
                <>
                  <h3>ZIP généré</h3>
                  {exportResult.zip_path && <p>{exportResult.zip_path}</p>}
                  {exportResult.download_url && (
                    <a href={exportResult.download_url} target="_blank" rel="noreferrer">
                      Télécharger le ZIP
                    </a>
                  )}
                </>
              ) : (
                <>
                  <h3>Dossier prêt QGIS généré</h3>
                  <p>{exportResult.folder_path ?? exportResult.export_dir}</p>
                </>
              )}

              <div className="result-grid">
                <div>
                  <strong>{exportResult.downloaded_count}</strong>
                  <span>Tuiles téléchargées</span>
                </div>
                <div>
                  <strong>{exportResult.failed_count}</strong>
                  <span>Échecs</span>
                </div>
                <div>
                  <strong>{exportResult.elapsed_seconds}s</strong>
                  <span>Durée</span>
                </div>
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
