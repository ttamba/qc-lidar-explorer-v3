/// <reference lib="webworker" />

import type { AoiFeature, TileFeature } from "../types";
import { intersectAoiWithTiles } from "./intersect";

type RuntimeTileFeature = TileFeature & {
  id?: string | number;
};

type IntersectWorkerRequest = {
  requestId: string;
  aoi: AoiFeature;
  tiles: RuntimeTileFeature[];
};

type IntersectWorkerResponse = {
  requestId: string;
  selectedIds?: string[];
  error?: string;
};

self.onmessage = (event: MessageEvent<IntersectWorkerRequest>) => {
  const { requestId, aoi, tiles } = event.data;

  try {
    const selected = intersectAoiWithTiles(aoi, tiles);
    const selectedIds = selected
      .map((tile) => String((tile as RuntimeTileFeature).id ?? ""))
      .filter(Boolean);

    const response: IntersectWorkerResponse = {
      requestId,
      selectedIds,
    };

    self.postMessage(response);
  } catch (error) {
    const response: IntersectWorkerResponse = {
      requestId,
      error: error instanceof Error ? error.message : "Erreur inconnue",
    };

    self.postMessage(response);
  }
};

export {};