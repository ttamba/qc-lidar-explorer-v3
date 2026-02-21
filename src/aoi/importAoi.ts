import { kml as kmlToGeoJSON } from "@tmcw/togeojson";
import { unzipSync } from "fflate";
import shp from "shpjs";

type GeoJSONAny = any;

export async function importAoiFromFile(file: File): Promise<GeoJSONAny> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".geojson") || name.endsWith(".json")) {
    return JSON.parse(await file.text());
  }

  if (name.endsWith(".kml")) {
    const text = await file.text();
    const dom = new DOMParser().parseFromString(text, "text/xml");
    return kmlToGeoJSON(dom);
  }

  if (name.endsWith(".kmz")) {
    // KMZ = zip contenant un KML (souvent doc.kml)
    const buf = new Uint8Array(await file.arrayBuffer());
    const unzipped = unzipSync(buf);

    const kmlEntry = Object.keys(unzipped).find((k) => k.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("KMZ: aucun fichier .kml trouvé.");

    const kmlText = new TextDecoder().decode(unzipped[kmlEntry]);
    const dom = new DOMParser().parseFromString(kmlText, "text/xml");
    return kmlToGeoJSON(dom);
  }

  if (name.endsWith(".zip")) {
    // Shapefile zip (au minimum .shp/.dbf/.shx)
    const ab = await file.arrayBuffer();
    const geo = await shp(ab);
    return geo;
  }

  throw new Error("Format AOI non supporté. Utilise GeoJSON, KML, KMZ ou Shapefile (.zip).");
}
