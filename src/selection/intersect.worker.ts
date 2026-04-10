/// <reference lib="webworker" />

import booleanIntersects from "@turf/boolean-intersects";
import type { AoiFeature } from "../types";
import type { WorkerCandidateTile } from "./intersect";

type IntersectWorkerRequest = {
  requestId: string;
  aoi: AoiFeature;
  candidates: WorkerCandidateTile[];
};

type IntersectWorkerResponse = {
  requestId: string;
  selectedIds?: string[];
  error?: string;
};

self.onmessage = (event: MessageEvent<IntersectWorkerRequest>) => {
  const { requestId, aoi, candidates } = event.data;

  try {
    const selectedIds: string[] = [];

    for (const candidate of candidates) {
      try {
        const tileFeature: GeoJSON.Feature = {
          type: "Feature",
          geometry: candidate.geometry,
          properties: {},
        };

        if (booleanIntersects(aoi as any, tileFeature as any)) {
          selectedIds.push(candidate.id);
        }
      } catch {
        // on ignore la tuile fautive pour préserver la robustesse
      }
    }

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