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
      ? `Mode utilisé: ZIP avec tuiles téléchargées directement\n- Tuiles incluses dans le ZIP: ${downloadedCount}\n- Échecs: ${failedCount}`
      : `Mode utilisé: ZIP d'inventaire avec liens de téléchargement\n- Les tuiles ne sont pas incluses directement dans le ZIP`;

  return `# Export QC LiDAR/MNT — Sélection de tuiles

Contenu:
- aoi.geojson
- selected_tiles.geojson
- tiles.csv
- README_QGIS.md

Selon le mode :
- inline-zip: le ZIP contient aussi les tuiles téléchargées
- inventory-only: le ZIP contient l'inventaire et les liens de téléchargement

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

function getBundleProductLabel(tiles: TileFeature[]) {
  const products = new Set(
    tiles
      .map((tile) => normalizeTile(tile).product)
      .filter((p): p is "lidar" | "mnt" => p === "lidar" || p === "mnt")
  );

  if (products.size === 1) {
    if (products.has("lidar")) return "lidar";
    if (products.has("mnt")) return "mnt";
  }

  if (products.size === 0) return "selection";
  return "lidar_mnt";
}

function estimateEtaMs(completed: number, total: number, startedAt: number) {
  if (completed <= 0 || total <= 0 || completed >= total) return 0;

  const elapsedMs = Date.now() - startedAt;
  const avgPerItem = elapsedMs / completed;
  const remaining = total - completed;

  return Math.max(0, Math.round(avgPerItem * remaining));
}

function linksToTxt(tiles: TileFeature[]) {
  return tiles
    .map((tile, i) => {
      const t = normalizeTile(tile);
      return t.url ? `${i + 1}. ${t.name} | ${t.product}\n${t.url}\n` : "";
    })
    .filter(Boolean)
    .join("\n");
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
  onProgress?: (progress: ExportProgress) => void,
  startedAt?: number,
  mode: ExportMode = "inline-zip"
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
        elapsedMs: startedAt ? Date.now() - startedAt : undefined,
        etaMs: startedAt ? estimateEtaMs(completed, tiles.length, startedAt) : undefined,
        mode,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, tiles.length)) }, () => worker())
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

  if (mode === "inventory-only") {
    zip.file("download_links.txt", linksToTxt(tiles));
  }

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
    mode: "inline-zip",
  });

  const { results, failures } = await downloadTilesWithConcurrency(
    tiles,
    DEFAULT_CONCURRENCY,
    onProgress,
    startedAt,
    "inline-zip"
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
    mode: "inline-zip",
  });

  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode: "inline-zip",
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
        mode: "inline-zip",
      });
    },
  });

  const productLabel = getBundleProductLabel(tiles);
  saveAs(blob, `qc_${productLabel}_data_${timestampString()}.zip`);

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
    mode: "inline-zip",
  });
}

async function exportInventoryOnly(
  aoi: AoiFeature,
  tiles: TileFeature[],
  onProgress?: (progress: ExportProgress) => void
) {
  const startedAt = Date.now();

  onProgress?.({
    phase: "zip",
    percent: 10,
    completed: 0,
    total: tiles.length,
    currentFile: undefined,
    message:
      "Création d’un ZIP d’inventaire. Les tuiles ne seront pas incluses dans le bundle.",
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: 0,
    etaMs: undefined,
    mode: "inventory-only",
  });

  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode: "inventory-only",
    onZipProgress: (zipPercent) => {
      const percent = 10 + Math.round((zipPercent / 100) * 80);

      onProgress?.({
        phase: "zip",
        percent: Math.min(95, percent),
        completed: 0,
        total: tiles.length,
        currentFile: undefined,
        message: "Préparation du ZIP d’inventaire en cours…",
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: Date.now() - startedAt,
        etaMs: undefined,
        mode: "inventory-only",
      });
    },
  });

  const productLabel = getBundleProductLabel(tiles);
  saveAs(blob, `qc_${productLabel}_selection_${timestampString()}.zip`);

  const validUrls = tiles
    .map((tile) => normalizeTile(tile).url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

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
      mode: "inventory-only",
    });
    alert("Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.");
    return;
  }

  alert(
    `Le ZIP d'inventaire a été généré.\n\n` +
      `${validUrls.length} lien(s) de téléchargement sont inclus dans download_links.txt.\n` +
      `Les téléchargements automatiques multiples ont été désactivés pour éviter le blocage par le navigateur.`
  );

  onProgress?.({
    phase: "done",
    percent: 100,
    completed: validUrls.length,
    total: tiles.length,
    currentFile: undefined,
    message: `ZIP d’inventaire généré. ${validUrls.length} lien(s) de téléchargement sont listés dans download_links.txt.`,
    downloadedCount: 0,
    failedCount: 0,
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
    mode: "inventory-only",
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
        `L'application va tenter de créer un vrai ZIP contenant les tuiles téléchargées.\n` +
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
      `Pour éviter les plantages mémoire du navigateur, l'application va créer un ZIP d'inventaire.\n\n` +
      `Les tuiles ne seront pas incluses directement dans le bundle.\n` +
      `Les liens de téléchargement seront listés dans download_links.txt.\n\n` +
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
