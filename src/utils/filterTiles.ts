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

export function extractAvailableYears(tiles: TileFeature[]): string[] {
  const years = new Set<string>();

  for (const tile of tiles) {
    const t = normalizeTile(tile);
    if (t.year) {
      years.add(t.year);
    }
  }

  return Array.from(years).sort((a, b) => Number(b) - Number(a));
}