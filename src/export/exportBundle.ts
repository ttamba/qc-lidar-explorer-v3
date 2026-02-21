import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { AoiFeature, TileFeature } from "../types";

function toCsv(tiles: TileFeature[]) {
  const header = ["product", "tile_id", "url", "year", "provider"];
  const rows = tiles.map((t) => [
    t.properties.product,
    t.properties.tile_id,
    t.properties.url,
    t.properties.year ?? "",
    t.properties.provider ?? "",
  ]);

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
- tiles.csv (liens de téléchargement)
- README_QGIS.md

## Objectif
Télécharger les tuiles (${tilesCount}) puis découper selon l’AOI dans QGIS.

## Étapes (QGIS)
1. Ouvrir \`aoi.geojson\` (glisser-déposer).
2. Ouvrir \`selected_tiles.geojson\` pour visualiser les empreintes sélectionnées.
3. Télécharger les fichiers référencés dans \`tiles.csv\`:
   - Option A: utiliser un script (PowerShell, Bash, Python) pour télécharger toutes les URLs.
   - Option B: outil/plug-in de téléchargement par URL si disponible dans votre environnement.

## Découpage
### MNT (raster)
- Utiliser GDAL: "Découper raster par masque" avec l’AOI.

### LiDAR (LAZ/LAS)
- Utiliser PDAL avec un crop polygonal (filters.crop) basé sur l’AOI.
- Exemple conceptuel:
  - input: tuile.laz
  - filters.crop: polygon = AOI
  - output: tuile_crop.laz

> MVP: le découpage n’est pas exécuté côté web pour éviter les traitements lourds.
`;
}

export async function exportBundle(params: { aoi: AoiFeature | null; tiles: TileFeature[] }) {
  const { aoi, tiles } = params;
  if (!aoi || tiles.length === 0) return;

  const zip = new JSZip();

  zip.file("aoi.geojson", JSON.stringify({ type: "FeatureCollection", features: [aoi] }, null, 2));
  zip.file("selected_tiles.geojson", JSON.stringify({ type: "FeatureCollection", features: tiles }, null, 2));
  zip.file("tiles.csv", toCsv(tiles));
  zip.file("README_QGIS.md", readmeQgisMd(tiles.length));

  const blob = await zip.generateAsync({ type: "blob" });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  saveAs(blob, `qc_lidar_mnt_selection_${stamp}.zip`);
}
