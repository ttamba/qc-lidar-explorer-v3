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

  return {
    id,
    name,
    product,
    url,
    year: p.year,
    provider: p.provider,
    raw: tile,
  };
}