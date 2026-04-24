import type { AoiFeature, TileFeature } from "../types";

const LOCAL_AGENT_BASE_URL = "http://127.0.0.1:8765";

export type LocalAgentOutputMode = "zip" | "folder";
export type LocalAgentPackageMode = "lean" | "full";

export type LocalAgentExportSettings = {
  outputDir: string;
  concurrency: number;
  retryCount: number;
  requestTimeoutSeconds: number;
  metadataDatasetName: string | null;
  keepDownloadedFiles: boolean;
  packageMode?: LocalAgentPackageMode;
  outputMode?: LocalAgentOutputMode;
};

export const DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS: LocalAgentExportSettings = {
  outputDir: "C:\\HQ\\exports",
  concurrency: 3,
  retryCount: 2,
  requestTimeoutSeconds: 180,
  metadataDatasetName: null,
  keepDownloadedFiles: false,
  packageMode: "lean",
  outputMode: "zip",
};

export type LocalAgentHealth = {
  ok?: boolean;
  service: string;
  version: string;
};

export type LocalAgentJobPhase =
  | "queued"
  | "prepare"
  | "estimate"
  | "download"
  | "metadata"
  | "zip"
  | "done"
  | "error";

export type LocalAgentJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LocalAgentJobStatus = {
  job_id?: string;
  status: LocalAgentJobState;
  phase: LocalAgentJobPhase;
  percent: number;
  completed: number;
  total: number;
  current_file?: string | null;
  message?: string | null;
  downloaded_count: number;
  failed_count: number;
  elapsed_ms?: number;
  eta_ms?: number;
  bytes_downloaded: number;
  bytes_total_estimated: number;
  avg_speed_mbps?: number | null;
  zip_path?: string | null;
  output_dir?: string | null;
  folder_path?: string | null;
};

export type LocalAgentTilePayload = {
  id?: string;
  url: string;
  filename?: string;
  product?: string;
  year?: string | number;
  properties?: Record<string, unknown>;
};

export type LocalAgentExportJob = {
  aoi: AoiFeature;
  tiles: LocalAgentTilePayload[];
  settings: LocalAgentExportSettings;
  outputDir: string;
  concurrency: number;
  retryCount: number;
  requestTimeoutSeconds: number;
  metadataDatasetName: string | null;
  keepDownloadedFiles: boolean;
  packageMode: LocalAgentPackageMode;
  outputMode: LocalAgentOutputMode;
};

export type LocalAgentCreateJobResponse = {
  job_id: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTile(tile: TileFeature): LocalAgentTilePayload {
  const props = asRecord(tile.properties);

  const url =
    stringValue(props.url) ??
    stringValue(props.URL) ??
    stringValue(props.download_url) ??
    stringValue(props.downloadUrl) ??
    stringValue(props.href) ??
    stringValue(props.HREF);

  if (!url) {
    throw new Error("Une tuile sélectionnée ne contient pas d’URL de téléchargement.");
  }

  return {
    id:
      stringValue(props.id) ??
      stringValue(props.ID) ??
      stringValue(props.tile_id) ??
      stringValue(props.tuile),
    url,
    filename:
      stringValue(props.filename) ??
      stringValue(props.file_name) ??
      stringValue(props.nom_fichier) ??
      stringValue(props.name),
    product:
      stringValue(props.normalized_product) ??
      stringValue(props.product) ??
      stringValue(props.PRODUIT) ??
      stringValue(props.type_produit),
    year:
      stringValue(props.year) ??
      stringValue(props.annee) ??
      stringValue(props.millesime),
    properties: props,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Erreur agent local ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function pingLocalAgent(): Promise<LocalAgentHealth> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/health`);
  const data = await parseJsonResponse<Record<string, unknown>>(response);

  return {
    ok: Boolean(data.ok ?? true),
    service: String(data.service ?? data.agent ?? "QC LiDAR / MNT Local Agent"),
    version: String(data.version ?? "unknown"),
  };
}

export function buildLocalExportJob(args: {
  aoi: AoiFeature;
  tiles: TileFeature[];
  settings: LocalAgentExportSettings;
}): LocalAgentExportJob {
  const outputMode = args.settings.outputMode ?? "zip";
  const packageMode = args.settings.packageMode ?? "lean";

  return {
    aoi: args.aoi,
    tiles: args.tiles.map(normalizeTile),
    settings: {
      ...args.settings,
      outputMode,
      packageMode,
      keepDownloadedFiles:
        outputMode === "folder" ? true : Boolean(args.settings.keepDownloadedFiles),
    },
    outputDir: args.settings.outputDir,
    concurrency: args.settings.concurrency,
    retryCount: args.settings.retryCount,
    requestTimeoutSeconds: args.settings.requestTimeoutSeconds,
    metadataDatasetName: args.settings.metadataDatasetName,
    keepDownloadedFiles:
      outputMode === "folder" ? true : Boolean(args.settings.keepDownloadedFiles),
    packageMode,
    outputMode,
  };
}

export async function createLocalExportJob(
  job: LocalAgentExportJob
): Promise<LocalAgentCreateJobResponse> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aoi: job.aoi,
      tiles: job.tiles,
      output_dir: job.outputDir,
      outputDir: job.outputDir,
      concurrency: job.concurrency,
      retry_count: job.retryCount,
      retryCount: job.retryCount,
      request_timeout_seconds: job.requestTimeoutSeconds,
      requestTimeoutSeconds: job.requestTimeoutSeconds,
      metadata_dataset_name: job.metadataDatasetName,
      metadataDatasetName: job.metadataDatasetName,
      keep_downloaded_files: job.keepDownloadedFiles,
      keepDownloadedFiles: job.keepDownloadedFiles,
      packageMode: job.packageMode,
      package_mode: job.packageMode,
      outputMode: job.outputMode,
      output_mode: job.outputMode,
      include_debug_files: false,
    }),
  });

  return parseJsonResponse<LocalAgentCreateJobResponse>(response);
}

export async function getLocalExportJobStatus(jobId: string): Promise<LocalAgentJobStatus> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/jobs/${encodeURIComponent(jobId)}`);
  const data = await parseJsonResponse<Record<string, unknown>>(response);

  return {
    job_id: stringValue(data.job_id) ?? stringValue(data.jobId) ?? jobId,
    status: (stringValue(data.status) ?? "running") as LocalAgentJobState,
    phase: (stringValue(data.phase) ?? "download") as LocalAgentJobPhase,
    percent: numberValue(data.percent, 0),
    completed: numberValue(data.completed, 0),
    total: numberValue(data.total, 0),
    current_file: stringValue(data.current_file) ?? stringValue(data.currentFile) ?? null,
    message: stringValue(data.message) ?? null,
    downloaded_count: numberValue(data.downloaded_count ?? data.downloadedCount, 0),
    failed_count: numberValue(data.failed_count ?? data.failedCount, 0),
    elapsed_ms: numberValue(data.elapsed_ms ?? data.elapsedMs, 0),
    eta_ms:
      data.eta_ms === undefined && data.etaMs === undefined
        ? undefined
        : numberValue(data.eta_ms ?? data.etaMs, 0),
    bytes_downloaded: numberValue(data.bytes_downloaded ?? data.bytesDownloaded, 0),
    bytes_total_estimated: numberValue(
      data.bytes_total_estimated ?? data.bytesTotalEstimated,
      0
    ),
    avg_speed_mbps:
      data.avg_speed_mbps === undefined && data.avgSpeedMbps === undefined
        ? null
        : numberValue(data.avg_speed_mbps ?? data.avgSpeedMbps, 0),
    zip_path: stringValue(data.zip_path) ?? stringValue(data.zipPath) ?? null,
    output_dir:
      stringValue(data.output_dir) ??
      stringValue(data.outputDir) ??
      stringValue(data.folder_path) ??
      stringValue(data.folderPath) ??
      null,
    folder_path: stringValue(data.folder_path) ?? stringValue(data.folderPath) ?? null,
  };
}

export async function cancelLocalExportJob(jobId: string): Promise<void> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Impossible d’annuler le job local ${jobId}: ${text || response.statusText}`);
  }
}
