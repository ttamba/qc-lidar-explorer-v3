import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { AoiFeature, TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

const MAX_INLINE_DOWNLOADS = 6;
const DEFAULT_CONCURRENCY =
  typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? Math.max(2, Math.min(6, navigator.hardwareConcurrency))
    : 4;

export type ExportMode = "inline-zip" | "inventory-only";

export type ExportProgress =
  | {
      phase: "idle";
      percent: 0;
      completed: 0;
      total: number;
      currentFile?: string;
      message?: string;
      downloadedCount?: number;
      failedCount?: number;
      elapsedMs?: number;
      etaMs?: number;
      mode?: ExportMode;
    }
  | {
      phase: "download";
      percent: number;
      completed: number;
      total: number;
      currentFile?: string;
      message?: string;
      downloadedCount?: number;
      failedCount?: number;
      elapsedMs?: number;
      etaMs?: number;
      mode?: ExportMode;
    }
  | {
      phase: "zip";
      percent: number;
      completed: number;
      total: number;
      currentFile?: string;
      message?: string;
      downloadedCount?: number;
      failedCount?: number;
      elapsedMs?: number;
      etaMs?: number;
      mode?: ExportMode;
    }
  | {
      phase: "done";
      percent: 100;
      completed: number;
      total: number;
      currentFile?: string;
      message?: string;
      downloadedCount?: number;
      failedCount?: number;
      elapsedMs?: number;
      etaMs?: number;
      mode?: ExportMode;
    }
  | {
      phase: "error";
      percent: number;
      completed: number;
      total: number;
      currentFile?: string;
      message: string;
      downloadedCount?: number;
      failedCount?: number;
      elapsedMs?: number;
      etaMs?: number;
      mode?: ExportMode;
    };

type DownloadFailure = {
  product: string;
  tile_id: string;
  name: string;
  url: string;
  error: string;
};

type DownloadedFile = {
  fileName: string;
  blob: Blob;
};

function toCsv(tiles: TileFeature[]) {
  const header = ["product", "tile_id", "name", "url", "year", "provider"];

  const rows = tiles.map((tile) => {
    const t = normalizeTile(tile);

    return [
      t.product,
      t.id,
      t.name,
      t.url,
      t.year ?? "",
      t.provider ?? "",
    ];
  });

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function failuresToCsv(failures: DownloadFailure[]) {
  const header = ["product", "tile_id", "name", "url", "error"];

  const rows = failures.map((f) => [
    f.product,
    f.tile_id,
    f.name,
    f.url,
    f.error,
  ]);

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function readmeQgisMd(
  totalCount: number,
  mode: ExportMode,
  downloadedCount = 0,
  failedCount = 0
) {
  const modeText =
    mode === "inline-zip"
      ? `Mode utilisé: ZIP avec tuiles téléchargées directement
- Tuiles incluses dans le ZIP: ${downloadedCount}
- Échecs: ${failedCount}`
      : `Mode utilisé: ZIP d'inventaire + ouverture des URLs dans de nouveaux onglets
- Les tuiles ne sont pas incluses dans le ZIP
- Le ZIP contient l'inventaire et les fichiers de contexte`;

  return `# Export QC LiDAR/MNT — Sélection de tuiles

Contenu:
- aoi.geojson
- selected_tiles.geojson
- tiles.csv
- README_QGIS.md

Selon le mode :
- inline-zip: le ZIP contient aussi les tuiles téléchargées
- inventory-only: les fichiers sources sont ouverts séparément dans le navigateur

## Résumé
- Tuiles sélectionnées: ${totalCount}
- ${modeText}

## Étapes QGIS
1. Ouvrir aoi.geojson
2. Ouvrir selected_tiles.geojson
3. Télécharger / vérifier les fichiers sources
4. Charger les données dans QGIS
`;
}

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function getExtensionFromUrl(url: string) {
  const cleanUrl = url.split("?")[0].split("#")[0];
  const match = cleanUrl.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "bin";
}

function timestampString() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function openUrlInNewTab(url: string, delayMs: number) {
  setTimeout(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, delayMs);
}

function estimateEtaMs(completed: number, total: number, startedAt: number) {
  if (completed <= 0 || total <= 0 || completed >= total) return 0;

  const elapsedMs = Date.now() - startedAt;
  const averagePerItem = elapsedMs / completed;
  const remaining = total - completed;

  return Math.max(0, Math.round(averagePerItem * remaining));
}

async function fetchAsBlob(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return await response.blob();
}

async function downloadTilesWithConcurrency(
  tiles: TileFeature[],
  concurrency: number,
  startedAt: number,
  mode: ExportMode,
  onProgress?: (progress: ExportProgress) => void
) {
  const results: DownloadedFile[] = [];
  const failures: DownloadFailure[] = [];

  let index = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= tiles.length) break;

      const tile = normalizeTile(tiles[currentIndex]);

      try {
        if (!tile.url) {
          throw new Error("URL absente");
        }

        const blob = await fetchAsBlob(tile.url);
        const ext = getExtensionFromUrl(tile.url);
        const fileName = sanitizeFileName(`${tile.name}.${ext}`);

        results.push({ fileName, blob });
      } catch (err: unknown) {
        failures.push({
          product: tile.product,
          tile_id: tile.id,
          name: tile.name,
          url: tile.url ?? "",
          error: err instanceof Error ? err.message : "Erreur inconnue",
        });
      }

      completed += 1;

      onProgress?.({
        phase: "download",
        completed,
        total: tiles.length,
        percent: Math.round((completed / tiles.length) * 90),
        currentFile: tile.name,
        message: "Téléchargement des tuiles en cours…",
        downloadedCount: results.length,
        failedCount: failures.length,
        elapsedMs: Date.now() - startedAt,
        etaMs: estimateEtaMs(completed, tiles.length, startedAt),
        mode,
      });
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, tiles.length)) },
      () => worker()
    )
  );

  return { results, failures };
}

async function buildInventoryZip(params: {
  aoi: AoiFeature;
  tiles: TileFeature[];
  mode: ExportMode;
  downloadedFiles?: DownloadedFile[];
  failures?: DownloadFailure[];
  onZipProgress?: (percent: number) => void;
}) {
  const {
    aoi,
    tiles,
    mode,
    downloadedFiles = [],
    failures = [],
    onZipProgress,
  } = params;

  const zip = new JSZip();

  zip.file(
    "aoi.geojson",
    JSON.stringify({ type: "FeatureCollection", features: [aoi] }, null, 2)
  );

  zip.file(
    "selected_tiles.geojson",
    JSON.stringify({ type: "FeatureCollection", features: tiles }, null, 2)
  );

  zip.file("tiles.csv", toCsv(tiles));

  if (downloadedFiles.length > 0) {
    const folder = zip.folder("downloaded_tiles");
    downloadedFiles.forEach(({ fileName, blob }) => {
      folder?.file(fileName, blob);
    });
  }

  if (failures.length > 0) {
    zip.file("failed_downloads.csv", failuresToCsv(failures));
  }

  zip.file(
    "README_QGIS.md",
    readmeQgisMd(tiles.length, mode, downloadedFiles.length, failures.length)
  );

  return await zip.generateAsync(
    { type: "blob" },
    (metadata) => {
      onZipProgress?.(metadata.percent);
    }
  );
}

async function exportInlineZip(
  aoi: AoiFeature,
  tiles: TileFeature[],
  onProgress?: (progress: ExportProgress) => void
) {
  const startedAt = Date.now();
  const mode: ExportMode = "inline-zip";

  onProgress?.({
    phase: "download",
    percent: 0,
    completed: 0,
    total: tiles.length,
    currentFile: undefined,
    message: "Préparation du téléchargement…",
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: 0,
    etaMs: undefined,
    mode,
  });

  const { results, failures } = await downloadTilesWithConcurrency(
    tiles,
    DEFAULT_CONCURRENCY,
    startedAt,
    mode,
    onProgress
  );

  onProgress?.({
    phase: "zip",
    percent: 92,
    completed: tiles.length,
    total: tiles.length,
    currentFile: undefined,
    message: "Création du bundle ZIP…",
    downloadedCount: results.length,
    failedCount: failures.length,
    elapsedMs: Date.now() - startedAt,
    etaMs: undefined,
    mode,
  });

  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode,
    downloadedFiles: results,
    failures,
    onZipProgress: (zipPercent) => {
      const percent = 92 + Math.round((zipPercent / 100) * 8);

      onProgress?.({
        phase: "zip",
        percent: Math.min(99, percent),
        completed: tiles.length,
        total: tiles.length,
        currentFile: undefined,
        message: "Compression du ZIP en cours…",
        downloadedCount: results.length,
        failedCount: failures.length,
        elapsedMs: Date.now() - startedAt,
        etaMs: undefined,
        mode,
      });
    },
  });

  saveAs(blob, `qc_lidar_mnt_data_${timestampString()}.zip`);

  const doneMessage =
    failures.length > 0
      ? `Export terminé. ${results.length} tuile(s) incluse(s), ${failures.length} en échec. Consultez failed_downloads.csv dans le ZIP.`
      : `Export terminé. ${results.length} tuile(s) incluse(s) dans le ZIP.`;

  onProgress?.({
    phase: "done",
    percent: 100,
    completed: tiles.length,
    total: tiles.length,
    currentFile: undefined,
    message: doneMessage,
    downloadedCount: results.length,
    failedCount: failures.length,
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
    mode,
  });
}

async function exportInventoryOnly(
  aoi: AoiFeature,
  tiles: TileFeature[],
  onProgress?: (progress: ExportProgress) => void
) {
  const startedAt = Date.now();
  const mode: ExportMode = "inventory-only";

  onProgress?.({
    phase: "zip",
    percent: 10,
    completed: 0,
    total: tiles.length,
    currentFile: undefined,
    message:
      "Sélection volumineuse détectée : création d’un ZIP d’inventaire. Les tuiles ne seront pas incluses dans le bundle.",
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: 0,
    etaMs: undefined,
    mode,
  });

  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode,
    onZipProgress: (zipPercent) => {
      const percent = 10 + Math.round((zipPercent / 100) * 75);

      onProgress?.({
        phase: "zip",
        percent: Math.min(90, percent),
        completed: 0,
        total: tiles.length,
        currentFile: undefined,
        message:
          "Création du ZIP d’inventaire en cours. Les téléchargements se feront séparément.",
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: Date.now() - startedAt,
        etaMs: undefined,
        mode,
      });
    },
  });

  saveAs(blob, `qc_lidar_mnt_selection_${timestampString()}.zip`);

  const validUrls = tiles
    .map((tile) => normalizeTile(tile).url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  onProgress?.({
    phase: "zip",
    percent: 95,
    completed: validUrls.length,
    total: tiles.length,
    currentFile: undefined,
    message: "Ouverture des liens de téléchargement…",
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: Date.now() - startedAt,
    etaMs: undefined,
    mode,
  });

  if (validUrls.length === 0) {
    onProgress?.({
      phase: "error",
      percent: 100,
      completed: 0,
      total: tiles.length,
      currentFile: undefined,
      message: "Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.",
      downloadedCount: 0,
      failedCount: 0,
      elapsedMs: Date.now() - startedAt,
      etaMs: 0,
      mode,
    });
    alert("Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.");
    return;
  }

  alert(
    `Le ZIP d'inventaire a été généré.\n\n` +
      `${validUrls.length} fichier(s) vont être ouverts dans de nouveaux onglets.\n` +
      `Les tuiles ne sont pas incluses dans le ZIP.\n\n` +
      `Autorisez les popups/téléchargements multiples si le navigateur le demande.`
  );

  validUrls.forEach((url, i) => {
    openUrlInNewTab(url, i * 1000);
  });

  onProgress?.({
    phase: "done",
    percent: 100,
    completed: validUrls.length,
    total: tiles.length,
    currentFile: undefined,
    message: `ZIP d’inventaire généré. ${validUrls.length} lien(s) ouverts dans le navigateur.`,
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
    mode,
  });
}

export async function exportBundle(params: {
  aoi: AoiFeature | null;
  tiles: TileFeature[];
  onProgress?: (progress: ExportProgress) => void;
}) {
  const { aoi, tiles, onProgress } = params;

  if (!aoi || tiles.length === 0) {
    const message = "Aucune AOI ou aucune tuile sélectionnée.";
    onProgress?.({
      phase: "error",
      percent: 0,
      completed: 0,
      total: tiles.length,
      currentFile: undefined,
      message,
      downloadedCount: 0,
      failedCount: 0,
      elapsedMs: 0,
      etaMs: undefined,
      mode: undefined,
    });
    alert(message);
    return;
  }

  const normalized = tiles.map((tile) => normalizeTile(tile));
  const withUrlCount = normalized.filter((t) => !!t.url).length;

  if (withUrlCount === 0) {
    const message = "Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.";
    onProgress?.({
      phase: "error",
      percent: 0,
      completed: 0,
      total: tiles.length,
      currentFile: undefined,
      message,
      downloadedCount: 0,
      failedCount: 0,
      elapsedMs: 0,
      etaMs: undefined,
      mode: undefined,
    });
    alert(message);
    return;
  }

  if (tiles.length <= MAX_INLINE_DOWNLOADS) {
    const proceed = confirm(
      `Petite sélection détectée (${tiles.length} tuile(s)).\n\n` +
        `L'application va créer un ZIP complet contenant les tuiles téléchargées.\n` +
        `Cela peut prendre du temps selon la taille des fichiers.\n\n` +
        `Continuer ?`
    );

    if (!proceed) {
      onProgress?.({
        phase: "idle",
        percent: 0,
        completed: 0,
        total: tiles.length,
        currentFile: undefined,
        message: "Export annulé.",
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: 0,
        etaMs: undefined,
        mode: "inline-zip",
      });
      return;
    }

    await exportInlineZip(aoi, tiles, onProgress);
    return;
  }

  const proceed = confirm(
    `Sélection volumineuse détectée (${tiles.length} tuiles).\n\n` +
      `Pour éviter les plantages mémoire du navigateur, l'application va créer un ZIP d'inventaire.\n` +
      `Les tuiles ne seront pas incluses dans le bundle et les URLs seront ouvertes séparément.\n\n` +
      `Continuer ?`
  );

  if (!proceed) {
    onProgress?.({
      phase: "idle",
      percent: 0,
      completed: 0,
      total: tiles.length,
      currentFile: undefined,
      message: "Export annulé.",
      downloadedCount: 0,
      failedCount: 0,
      elapsedMs: 0,
      etaMs: undefined,
      mode: "inventory-only",
    });
    return;
  }

  await exportInventoryOnly(aoi, tiles, onProgress);
}