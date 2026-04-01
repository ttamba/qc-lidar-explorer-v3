import { normalizeTile } from "./normalizeTile";
import type { TileFeature } from "../types";

export function filterTilesByYear(
  tiles: TileFeature[],
  selectedYear: string | "ALL"
): TileFeature[] {
  if (!selectedYear || selectedYear === "ALL") return tiles;

  return tiles.filter((tile) => {
    const t = normalizeTile(tile);
    return t.year === selectedYear;
  });
}