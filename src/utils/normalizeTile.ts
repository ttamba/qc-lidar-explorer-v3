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

function extractMntYear(p: Record<string, any>): string | undefined {
  const raw = String(p.DATES_AQUISITION ?? "").trim();
  const year = raw.slice(0, 4);

  if (/^(19|20)\d{2}$/.test(year)) {
    return year;
  }

  return undefined;
}

function extractLidarYear(p: Record<string, any>): string | undefined {
  const raw = String(p.NOM_TUILE ?? "").trim();
  const yy = raw.slice(0, 2);

  if (!/^\d{2}$/.test(yy)) {
    return undefined;
  }

  const n = Number(yy);

  return String(n <= 79 ? 2000 + n : 1900 + n);
}

function extractYearByProduct(
  product: "lidar" | "mnt" | "",
  p: Record<string, any>
): string | undefined {
  if (product === "mnt") {
    return extractMntYear(p);
  }

  if (product === "lidar") {
    return extractLidarYear(p);
  }

  return undefined;
}

export function normalizeTile(tile: TileFeature): NormalizedTile {
  const p = (tile?.properties ?? {}) as Record<string, any>;

  const product = String(p.product ?? "").toLowerCase() as "lidar" | "mnt" | "";

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

  const year =
    (p.year ? String(p.year) : undefined) ??
    extractYearByProduct(product, p);

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