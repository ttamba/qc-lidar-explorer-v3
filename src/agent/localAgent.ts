import type { AoiFeature, TileFeature } from "../types";

export const LOCAL_AGENT_BASE_URL = "http://127.0.0.1:8765";

export type LocalAgentOutputMode = "zip" | "folder";
export type LocalAgentPackageMode = "lean" | "full";
export type LocalAgentProduct = "lidar" | "mnt" | "orthophoto" | "mixed" | "unknown";

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
  metadata_source_name: string;
  metadata_dataset_name: string | null;
  package_mode: LocalAgentPackageMode;
  output_mode?: LocalAgentOutputMode;
};

export type LocalAgentExportJob = {
  job_id: string;
  created_at: string;
  product: LocalAgentProduct;
  output_dir: string;
  zip_name: string;
  aoi_geojson: Record<string, unknown>;
  tiles: LocalAgentTilePayload[];
  options: LocalAgentJobOptions;
};

export type LocalAgentCreateJobResponse = {
  job_id: string;
  status?: LocalAgentJobState;
  phase?: LocalAgentJobPhase;
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

function sanitizeName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildLocalExportJobId() {
  const now = new Date();
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  
   const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    pad(now.getMilliseconds(), 3),
  ].join("");
  
  const random = Math.random().toString(36).slice(2, 8);
  
  return `job-${timestamp}-${random}`;
}

function inferProductFromTiles(tiles: LocalAgentTilePayload[]): LocalAgentProduct {
  const products = new Set(
    tiles
      .map((tile) => tile.product)
      .filter((product): product is "lidar" | "mnt" => product === "lidar" || product === "mnt")
  );

  if (products.size === 1) {
    if (products.has("lidar")) return "lidar";
    if (products.has("mnt")) return "mnt";
  }

  if (products.size > 1) return "mixed";
  return "unknown";
}

function buildLocalZipName(product: LocalAgentProduct, jobId: string) {
  return sanitizeName(`qc_${product}_bundle_${jobId}.zip`);
}

function normalizeProduct(value: unknown): LocalAgentProduct {
  const text = stringValue(value)?.toLowerCase();

  if (text === "lidar") return "lidar";
  if (text === "mnt") return "mnt";
  if (text === "orthophoto") return "orthophoto";

  return "unknown";
}

function normalizeTile(tile: TileFeature): LocalAgentTilePayload {
  const props = asRecord(tile.properties);

  const url =
    stringValue(props.normalized_url) ??
    stringValue(props.url) ??
    stringValue(props.URL) ??
    stringValue(props.TELECHARGEMENT_TUILE) ??
    stringValue(props.download_url) ??
    stringValue(props.downloadUrl) ??
    stringValue(props.href) ??
    stringValue(props.HREF);

  if (!url) {
    throw new Error("Une tuile sélectionnée ne contient pas d’URL de téléchargement.");
  }

  const tileId =
    stringValue(props.normalized_id) ??
    stringValue(props.tile_id) ??
    stringValue(props.id) ??
    stringValue(props.ID) ??
    stringValue(props.NOM_TUILE) ??
    stringValue(props.tuile) ??
    stringValue((tile as unknown as Record<string, unknown>).id) ??
    "tile";

  const name =
    stringValue(props.normalized_name) ??
    stringValue(props.NOM_TUILE) ??
    stringValue(props.filename) ??
    stringValue(props.file_name) ??
    stringValue(props.nom_fichier) ??
    stringValue(props.name) ??
    tileId;

  const product = normalizeProduct(
    props.normalized_product ?? props.product ?? props.PRODUIT ?? props.type_produit
  );

  return {
    tile_id: tileId,
    name,
    product,
    year:
      stringValue(props.normalized_year) ??
      stringValue(props.year) ??
      stringValue(props.annee) ??
      stringValue(props.millesime) ??
      null,
    url,
    provider:
      stringValue(props.normalized_provider) ??
      stringValue(props.provider) ??
      stringValue(props.PROVIDER) ??
      "QC",
    source_attributes: props,
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
    ok: data.ok === undefined ? data.status === "ok" : Boolean(data.ok),
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
  const localTiles = args.tiles.map(normalizeTile);
  const product = inferProductFromTiles(localTiles);
  const jobId = buildLocalExportJobId();

  const keepDownloadedFiles =
    outputMode === "folder" ? true : Boolean(args.settings.keepDownloadedFiles);

  return {
    job_id: jobId,
    created_at: new Date().toISOString(),
    product,
    output_dir: args.settings.outputDir,
    zip_name: buildLocalZipName(product, jobId),
    aoi_geojson: {
      type: "FeatureCollection",
      features: [args.aoi],
    },
    tiles: localTiles,
    options: {
      concurrency: clamp(args.settings.concurrency, 1, 8, 3),
      retry_count: clamp(args.settings.retryCount, 0, 5, 1),
      create_zip: outputMode === "zip",
      keep_downloaded_files: keepDownloadedFiles,
      request_timeout_seconds: clamp(args.settings.requestTimeoutSeconds, 10, 3600, 180),
      metadata_source_name: "Gouvernement du Québec",
      metadata_dataset_name: args.settings.metadataDatasetName ?? null,
      package_mode: packageMode,
      output_mode: outputMode,
    },
  };
}

export async function createLocalExportJob(
  job: LocalAgentExportJob
): Promise<LocalAgentCreateJobResponse> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });

  const data = await parseJsonResponse<Record<string, unknown>>(response);

  return {
    job_id: stringValue(data.job_id) ?? stringValue(data.jobId) ?? job.job_id,
    status: stringValue(data.status) as LocalAgentJobState | undefined,
    phase: stringValue(data.phase) as LocalAgentJobPhase | undefined,
  };
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
  const response = await fetch(
    `${LOCAL_AGENT_BASE_URL}/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Impossible d’annuler le job local ${jobId}: ${text || response.statusText}`);
  }
}
