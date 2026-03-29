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

function toCsv(tiles: TileFeature[]) {
  const header = ["product", "tile_id", "url", "year", "provider"];
  const rows = tiles.map((t) => {
    const p = t.properties as Record<string, any>;
    return [
      p.product ?? "",
      p.tile_id ?? p.NOM_TUILE ?? "",
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

function readmeQgisMd(tilesCount: number) {
  return `# Export QC LiDAR/MNT — Sélection de tuiles

Contenu:
- aoi.geojson
- selected_tiles.geojson
- tiles.csv
- README_QGIS.md

## Résumé
- Tuiles sélectionnées: ${tilesCount}

## Téléchargement des données
Les fichiers sources (LAZ/TIF) sont téléchargés directement par le navigateur, un par un,
pour éviter les plantages mémoire liés à la création d'un gros ZIP côté client.

## Étapes QGIS
1. Ouvrir aoi.geojson
2. Ouvrir selected_tiles.geojson
3. Utiliser les fichiers téléchargés localement
`;
}

function triggerDirectDownload(url: string, delayMs: number) {
  setTimeout(() => {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    .map((t) => getTileUrl(t))
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  if (validUrls.length === 0) {
    alert("Aucune URL de téléchargement trouvée pour les tuiles sélectionnées.");
    return;
  }

  const msg =
    `Le ZIP d'inventaire a été généré.\n\n` +
    `${validUrls.length} téléchargement(s) direct(s) vont être lancés.\n` +
    `Selon le navigateur, vous devrez peut-être autoriser les téléchargements multiples pour ce site.`;

  alert(msg);

  validUrls.forEach((url, i) => {
    triggerDirectDownload(url, i * 1200);
  });
}