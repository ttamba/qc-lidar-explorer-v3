import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { AoiFeature, TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

const MAX_INLINE_DOWNLOADS = 4; // seuil prudent pour zipper dans le navigateur

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

function failuresToCsv(
  failures: Array<{
    product: string;
    tile_id: string;
    name: string;
    url: string;
    error: string;
  }>
) {
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
  mode: "inline-zip" | "inventory-only",
  downloadedCount = 0,
  failedCount = 0
) {
  const modeText =
    mode === "inline-zip"
      ? `Mode utilisé: ZIP avec tuiles téléchargées directement\n- Tuiles incluses dans le ZIP: ${downloadedCount}\n- Échecs: ${failedCount}`
      : `Mode utilisé: ZIP d'inventaire + ouverture des URLs dans de nouveaux onglets`;

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

async function fetchAsBlob(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return await response.blob();
}

async function buildInventoryZip(params: {
  aoi: AoiFeature;
  tiles: TileFeature[];
  mode: "inline-zip" | "inventory-only";
  downloadedFiles?: Array<{ fileName: string; blob: Blob }>;
  failures?: Array<{
    product: string;
    tile_id: string;
    name: string;
    url: string;
    error: string;
  }>;
}) {
  const {
    aoi,
    tiles,
    mode,
    downloadedFiles = [],
    failures = [],
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

  return await zip.generateAsync({ type: "blob" });
}

async function exportInlineZip(aoi: AoiFeature, tiles: TileFeature[]) {
  const failures: Array<{
    product: string;
    tile_id: string;
    name: string;
    url: string;
    error: string;
  }> = [];

  const downloadedFiles: Array<{ fileName: string; blob: Blob }> = [];

  for (const tile of tiles) {
    const t = normalizeTile(tile);

    if (!t.url) {
      failures.push({
        product: t.product,
        tile_id: t.id,
        name: t.name,
        url: "",
        error: "URL de téléchargement absente",
      });
      continue;
    }

    try {
      const blob = await fetchAsBlob(t.url);
      const ext = getExtensionFromUrl(t.url);
      const fileName = sanitizeFileName(`${t.name}.${ext}`);
      downloadedFiles.push({ fileName, blob });
    } catch (err: any) {
      failures.push({
        product: t.product,
        tile_id: t.id,
        name: t.name,
        url: t.url,
        error: err?.message ?? "Erreur inconnue",
      });
    }
  }

  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode: "inline-zip",
    downloadedFiles,
    failures,
  });

  saveAs(blob, `qc_lidar_mnt_data_${timestampString()}.zip`);

  if (failures.length > 0) {
    alert(
      `${downloadedFiles.length} tuile(s) incluse(s) dans le ZIP, ${failures.length} en échec.\n` +
        `Consulte failed_downloads.csv dans le ZIP.`
    );
  }
}

async function exportInventoryOnly(aoi: AoiFeature, tiles: TileFeature[]) {
  const blob = await buildInventoryZip({
    aoi,
    tiles,
    mode: "inventory-only",
  });

  saveAs(blob, `qc_lidar_mnt_selection_${timestampString()}.zip`);

  const validUrls = tiles
    .map((tile) => normalizeTile(tile).url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  if (validUrls.length === 0) {
    alert("Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.");
    return;
  }

  alert(
    `Le ZIP d'inventaire a été généré.\n\n` +
      `${validUrls.length} fichier(s) vont être ouverts dans de nouveaux onglets.\n` +
      `Autorisez les popups/téléchargements multiples si le navigateur le demande.`
  );

  validUrls.forEach((url, i) => {
    openUrlInNewTab(url, i * 1000);
  });
}

export async function exportBundle(params: { aoi: AoiFeature | null; tiles: TileFeature[] }) {
  const { aoi, tiles } = params;

  if (!aoi || tiles.length === 0) {
    alert("Aucune AOI ou aucune tuile sélectionnée.");
    return;
  }

  const normalized = tiles.map((tile) => normalizeTile(tile));
  const withUrlCount = normalized.filter((t) => !!t.url).length;

  if (withUrlCount === 0) {
    alert("Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.");
    return;
  }

  if (tiles.length <= MAX_INLINE_DOWNLOADS) {
    const proceed = confirm(
      `Petite sélection détectée (${tiles.length} tuile(s)).\n\n` +
        `L'application va tenter de créer un vrai ZIP contenant les tuiles téléchargées.\n` +
        `Cela peut prendre du temps selon la taille des fichiers.\n\n` +
        `Continuer ?`
    );

    if (!proceed) return;

    await exportInlineZip(aoi, tiles);
    return;
  }

  const proceed = confirm(
    `Sélection volumineuse détectée (${tiles.length} tuiles).\n\n` +
      `Pour éviter les plantages mémoire du navigateur, l'application va créer un ZIP d'inventaire ` +
      `et ouvrir les URLs de téléchargement séparément.\n\n` +
      `Continuer ?`
  );

  if (!proceed) return;

  await exportInventoryOnly(aoi, tiles);
}