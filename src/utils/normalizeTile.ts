import type { TileFeature } from "../types";

export type NormalizedTile = {
  id: string;
  name: string;
  product: "lidar" | "mnt" | "";
  url: string;
  year?: string;
  provider?: string;
  raw: TileFeature;
};

function extractYearFromDateAcquisition(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  const year = raw.slice(0, 4);

  if (/^(19|20)\d{2}$/.test(year)) {
    return year;
  }

  return undefined;
}

function extractMntYearFromName(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();

  // Ex.: MNT2024_7371_4575_CCL_1M
  const match = raw.match(/MNT(19|20)\d{2}/i);
  if (match) {
    return match[0].slice(3);
  }

  // fallback générique: première année à 4 chiffres trouvée
  const fallback = raw.match(/\b(19|20)\d{2}\b/);
  if (fallback) {
    return fallback[0];
  }

  return undefined;
}

function extractLidarYearFromName(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  const yy = raw.slice(0, 2);

  if (!/^\d{2}$/.test(yy)) {
    return undefined;
  }

  const n = Number(yy);

  // 00-79 => 2000-2079 ; 80-99 => 1980-1999
  return String(n <= 79 ? 2000 + n : 1900 + n);
}

function inferProduct(p: Record<string, any>): "lidar" | "mnt" | "" {
  const explicit = String(p.product ?? "").toLowerCase();
  if (explicit === "lidar" || explicit === "mnt") {
    return explicit;
  }

  const name = String(p.NOM_TUILE ?? p.tile_id ?? "").toUpperCase();

  if (name.startsWith("MNT")) return "mnt";

  // Heuristique légère pour LiDAR : souvent préfixe 2 chiffres dans NOM_TUILE
  if (/^\d{2}/.test(name)) return "lidar";

  return "";
}

function extractYear(
  product: "lidar" | "mnt" | "",
  p: Record<string, any>
): string | undefined {
  if (product === "mnt") {
    return (
      extractYearFromDateAcquisition(p.DATES_AQUISITION) ??
      extractMntYearFromName(p.NOM_TUILE) ??
      extractMntYearFromName(p.tile_id)
    );
  }

  if (product === "lidar") {
    return extractLidarYearFromName(p.NOM_TUILE) ?? extractLidarYearFromName(p.tile_id);
  }

  // fallback si product absent/mal renseigné
  return (
    extractYearFromDateAcquisition(p.DATES_AQUISITION) ??
    extractMntYearFromName(p.NOM_TUILE) ??
    extractMntYearFromName(p.tile_id) ??
    extractLidarYearFromName(p.NOM_TUILE) ??
    extractLidarYearFromName(p.tile_id)
  );
}

export function normalizeTile(tile: TileFeature): NormalizedTile {
  const p = (tile?.properties ?? {}) as Record<string, any>;

  const product = inferProduct(p);

  const id = String(
    p.tile_id ??
      p.NOM_TUILE ??
      "unknown"
  );

  const name = String(
    p.NOM_TUILE ??
      p.tile_id ??
      id
  );

  const url = String(
    p.url ??
      p.download_url ??
      p.TELECHARGEMENT_TUILE ??
      p.telechargement_tuile ??
      ""
  );

  const year = extractYear(product, p);

  return {
    id,
    name,
    product,
    url,
    year,
    provider: p.provider,
    raw: tile,
  };
}