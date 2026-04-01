import type { TileFeature } from "../types";

export type NormalizedTile = {
  id: string;
  name: string;
  product: "lidar" | "mnt" | "";
  url: string;
  year?: number | string;
  provider?: string;
  raw: TileFeature;
};

function extractYearFromTileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  const first4 = trimmed.slice(0, 4);

  if (/^(19|20)\d{2}$/.test(first4)) {
    return first4;
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

  const derivedYear =
    p.year ??
    extractYearFromTileName(p.NOM_TUILE) ??
    extractYearFromTileName(p.tile_id);

  return {
    id,
    name,
    product,
    url,
    year: derivedYear,
    provider: p.provider,
    raw: tile,
  };
}