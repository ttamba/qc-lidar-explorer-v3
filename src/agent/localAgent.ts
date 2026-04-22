import type { AoiFeature, TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

export const LOCAL_AGENT_BASE_URL = "http://127.0.0.1:8765";

export type LocalAgentHealth = {
  status: string;
  service: string;
  version: string;
};

export type LocalAgentProduct =
  | "lidar"
  | "mnt"
  | "orthophoto"
  | "mixed"
  | "unknown";

export type LocalAgentJobStatusValue =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LocalAgentJobPhase =
  | "queued"
  | "prepare"
  | "estimate"
  | "download"
  | "zip"
  | "done"
  | "error";

export type LocalAgentTile = {
  tile_id: string;
  name: string;
  product: LocalAgentProduct;
  year?: string | null;
  url?: string | null;
  provider?: string | null;
  source_attributes?: Record<string, unknown> | null;
};

export type LocalAgentJobOptions = {
  concurrency: number;
  retry_count: number;
  create_zip: boolean;
  keep_downloaded_files: boolean;
  request_timeout_seconds: number;
  metadata_source_name?: string;
  metadata_dataset_name?: string | null;
};

export type LocalAgentCreateJobRequest = {
  job_id: string;
  created_at: string;
  product: LocalAgentProduct;
  output_dir: string;
  zip_name: string;
  aoi_geojson: Record<string, unknown>;
  tiles: LocalAgentTile[];
  options: LocalAgentJobOptions;
};

export type LocalAgentJobStatus = {
  job_id: string;
  status: LocalAgentJobStatusValue;
  phase: LocalAgentJobPhase;
  percent: number;
  completed: number;
  total: number;
  current_file?: string | null;
  downloaded_count: number;
  failed_count: number;
  elapsed_ms: number;
  eta_ms: number;
  avg_speed_mbps?: number | null;
  bytes_downloaded: number;
  bytes_total_estimated: number;
  current_file_bytes_downloaded: number;
  current_file_bytes_total: number;
  zip_completed_files: number;
  zip_total_files: number;
  zip_bytes_processed: number;
  zip_bytes_total: number;
  message?: string | null;
  output_dir?: string | null;
  zip_path?: string | null;
  created_at: string;
  updated_at: string;
};

export type LocalAgentExportSettings = {
  outputDir: string;
  concurrency: number;
  retryCount: number;
  requestTimeoutSeconds: number;
  keepDownloadedFiles: boolean;
  metadataDatasetName?: string | null;
};

export const DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS: LocalAgentExportSettings = {
  outputDir: "C:\\HQ\\exports",
  concurrency: 3,
  retryCount: 1,
  requestTimeoutSeconds: 120,
  keepDownloadedFiles: false,
  metadataDatasetName: null,
};

function ensureOk(res: Response) {
  if (!res.ok) {
    throw new Error(`Agent local HTTP ${res.status}`);
  }
}

function sanitizeName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function clampConcurrency(value: number) {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, Math.round(value)));
}

function clampRetryCount(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(5, Math.round(value)));
}

function clampTimeout(value: number) {
  if (!Number.isFinite(value)) return 120;
  return Math.max(10, Math.min(3600, Math.round(value)));
}

export function buildLocalExportJobId() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  return `job-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function inferAgentProductLabel(
  products: Array<"" | "lidar" | "mnt">
): LocalAgentProduct {
  const valid = new Set(
    products.filter((p): p is "lidar" | "mnt" => p === "lidar" || p === "mnt")
  );

  if (valid.size === 1) {
    if (valid.has("lidar")) return "lidar";
    if (valid.has("mnt")) return "mnt";
  }

  if (valid.size > 1) return "mixed";
  return "unknown";
}

export function buildLocalZipName(
  products: Array<"" | "lidar" | "mnt">,
  jobId: string
) {
  const label = inferAgentProductLabel(products);
  return sanitizeName(`qc_${label}_bundle_${jobId}.zip`);
}

export function mapTilesToLocalAgentTiles(
  tiles: TileFeature[]
): LocalAgentTile[] {
  return tiles.map((tile) => {
    const t = normalizeTile(tile);

    const product: LocalAgentProduct =
      t.product === "lidar" || t.product === "mnt" ? t.product : "unknown";

    const rawProperties =
      tile && typeof tile === "object" && "properties" in tile
        ? ((tile as { properties?: Record<string, unknown> }).properties ?? null)
        : null;

    return {
      tile_id: t.id,
      name: t.name,
      product,
      year: t.year ?? null,
      url: t.url ?? null,
      provider: t.provider ?? null,
      source_attributes: rawProperties,
    };
  });
}

export function buildLocalExportJob(params: {
  aoi: AoiFeature;
  tiles: TileFeature[];
  settings: LocalAgentExportSettings;
}): LocalAgentCreateJobRequest {
  const { aoi, tiles, settings } = params;

  const normalizedProducts = tiles.map((tile) => normalizeTile(tile).product);
  const jobId = buildLocalExportJobId();

  return {
    job_id: jobId,
    created_at: new Date().toISOString(),
    product: inferAgentProductLabel(normalizedProducts),
    output_dir: settings.outputDir,
    zip_name: buildLocalZipName(normalizedProducts, jobId),
    aoi_geojson: {
      type: "FeatureCollection",
      features: [aoi],
    },
    tiles: mapTilesToLocalAgentTiles(tiles),
    options: {
      concurrency: clampConcurrency(settings.concurrency),
      retry_count: clampRetryCount(settings.retryCount),
      create_zip: true,
      keep_downloaded_files: settings.keepDownloadedFiles,
      request_timeout_seconds: clampTimeout(settings.requestTimeoutSeconds),
      metadata_source_name: "Gouvernement du Québec",
      metadata_dataset_name: settings.metadataDatasetName ?? null,
    },
  };
}

export async function pingLocalAgent(): Promise<LocalAgentHealth> {
  const res = await fetch(`${LOCAL_AGENT_BASE_URL}/health`, {
    method: "GET",
  });
  ensureOk(res);
  return res.json();
}

export async function createLocalExportJob(
  payload: LocalAgentCreateJobRequest
): Promise<LocalAgentJobStatus> {
  const res = await fetch(`${LOCAL_AGENT_BASE_URL}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  ensureOk(res);
  return res.json();
}

export async function getLocalExportJobStatus(
  jobId: string
): Promise<LocalAgentJobStatus> {
  const res = await fetch(
    `${LOCAL_AGENT_BASE_URL}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
    }
  );
  ensureOk(res);
  return res.json();
}

export async function cancelLocalExportJob(jobId: string): Promise<void> {
  const res = await fetch(
    `${LOCAL_AGENT_BASE_URL}/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
    }
  );
  ensureOk(res);
}