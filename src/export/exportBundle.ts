import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { AoiFeature, TileFeature } from "../types";

function getTileUrl(tile: TileFeature): string | null {
  const p = tile.properties as Record<string, any>;

  return (
    p.TELECHARGEMENT_TUILE ??
    p.telechargement_tuile ??
    p.url ??
    p.download_url ??
    null
  );
}

function getTileName(tile: TileFeature, index: number): string {
  const p = tile.properties as Record<string, any>;

  const rawName =
    p.NOM_TUILE ??
    p.nom_tuile ??
    p.tile_id ??
    `tile_${index + 1}`;

  return String(rawName).replace(/[<>:"/\\|?*]+/g, "_");
}

function getExtensionFromUrl(url: string): string {
  const cleanUrl = url.split("?")[0].split("#")[0];
  const match = cleanUrl.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "bin";
}

function toCsv(tiles: TileFeature[]) {
  const header = ["product", "tile_id", "NOM_TUILE", "url", "year", "provider"];

  const rows = tiles.map((t) => {
    const p = t.properties as Record<string, any>;
    return [
      p.product ?? "",
      p.tile_id ?? "",
      p.NOM_TUILE ?? p.nom_tuile ?? "",
      getTileUrl(t) ?? "",
      p.year ?? "",
      p.provider ?? "",
    ];
  });

  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function readmeQgisMd(total: number, downloaded: number, failed: number) {
  return `# Export QC LiDAR/MNT — Données téléchargées

Contenu:
- aoi.geojson
- selected_tiles.geojson
- tiles.csv
- downloaded_tiles/...
- failed_downloads.csv (si applicable)
- README_QGIS.md

## Résumé
- Tuiles sélectionnées: ${total}
- Tuiles téléchargées: ${downloaded}
- Tuiles en échec: ${failed}

## Notes
- Cet export tente de télécharger automatiquement les fichiers sources des tuiles intersectant l'AOI.
- Si certaines tuiles échouent, vérifier les restrictions réseau/CORS ou relancer l'export.

## Étapes (QGIS)
1. Ouvrir \`aoi.geojson\`.
2. Ouvrir les données téléchargées dans \`downloaded_tiles/\`.
3. Découper selon l'AOI si nécessaire.

## Découpage
### MNT (raster)
- Utiliser GDAL: "Découper raster par masque" avec l’AOI.

### LiDAR (LAZ/LAS)
- Utiliser PDAL avec \`filters.crop\` sur le polygone AOI.
`;
}

async function fetchTileAsBlob(url: string): Promise<Blob> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return await response.blob();
}

function failuresToCsv(
  failures: Array<{ product: string; tile_id: string; name: string; url: string; error: string }>
) {
  const header = ["product", "tile_id", "name", "url", "error"];

  const rows = failures.map((f) => [
    f.product,
    f.tile_id,
    f.name,
    f.url,
    f.error,
  ]);

  const esc = (v: any) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export async function exportBundle(params: { aoi: AoiFeature | null; tiles: TileFeature[] }) {
  const { aoi, tiles } = params;

  if (!aoi || tiles.length === 0) {
    alert("Aucune AOI ou aucune tuile sélectionnée.");
    return;
  }

  const zip = new JSZip();
  const dataFolder = zip.folder("downloaded_tiles");

  zip.file(
    "aoi.geojson",
    JSON.stringify({ type: "FeatureCollection", features: [aoi] }, null, 2)
  );

  zip.file(
    "selected_tiles.geojson",
    JSON.stringify({ type: "FeatureCollection", features: tiles }, null, 2)
  );

  zip.file("tiles.csv", toCsv(tiles));

  const failures: Array<{
    product: string;
    tile_id: string;
    name: string;
    url: string;
    error: string;
  }> = [];

  let downloadedCount = 0;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const p = tile.properties as Record<string, any>;

    const url = getTileUrl(tile);
    const tileName = getTileName(tile, i);
    const product = String(p.product ?? "unknown");
    const tileId = String(p.tile_id ?? tileName);

    if (!url) {
      failures.push({
        product,
        tile_id: tileId,
        name: tileName,
        url: "",
        error: "URL de téléchargement absente",
      });
      continue;
    }

    try {
      const blob = await fetchTileAsBlob(url);
      const ext = getExtensionFromUrl(url);
      const fileName = `${tileName}.${ext}`;

      dataFolder?.file(fileName, blob);
      downloadedCount += 1;
    } catch (err: any) {
      failures.push({
        product,
        tile_id: tileId,
        name: tileName,
        url,
        error: err?.message ?? "Erreur inconnue",
      });
    }
  }

  if (failures.length > 0) {
    zip.file("failed_downloads.csv", failuresToCsv(failures));
  }

  zip.file(
    "README_QGIS.md",
    readmeQgisMd(tiles.length, downloadedCount, failures.length)
  );

  const blob = await zip.generateAsync({ type: "blob" });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  saveAs(blob, `qc_lidar_mnt_data_${stamp}.zip`);

  if (failures.length > 0) {
    alert(
      `${downloadedCount} tuile(s) téléchargée(s), ${failures.length} en échec.\n` +
        `Consulte failed_downloads.csv dans le ZIP.`
    );
  }
}