import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { AoiFeature, TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

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

function readmeQgisMd(tilesCount: number) {
  return `# Export QC LiDAR/MNT — Sélection de tuiles

Contenu:
- aoi.geojson
- selected_tiles.geojson
- tiles.csv
- README_QGIS.md

## Résumé
- Tuiles sélectionnées: ${tilesCount}

## Téléchargement
Les fichiers sources sont ouverts dans de nouveaux onglets/fenêtres
pour éviter les plantages ou remplacements de l'application dans l'onglet principal.

Selon le navigateur, vous devrez peut-être autoriser les popups/téléchargements multiples.

## Étapes QGIS
1. Ouvrir aoi.geojson
2. Ouvrir selected_tiles.geojson
3. Télécharger les fichiers référencés
4. Charger les données dans QGIS
`;
}

function openUrlInNewTab(url: string, delayMs: number) {
  setTimeout(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, delayMs);
}

export async function exportBundle(params: { aoi: AoiFeature | null; tiles: TileFeature[] }) {
  const { aoi, tiles } = params;

  if (!aoi || tiles.length === 0) {
    alert("Aucune AOI ou aucune tuile sélectionnée.");
    return;
  }

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
  zip.file("README_QGIS.md", readmeQgisMd(tiles.length));

  const blob = await zip.generateAsync({ type: "blob" });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  saveAs(blob, `qc_lidar_mnt_selection_${stamp}.zip`);

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