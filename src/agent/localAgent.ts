/**
 * src/agent/localAgent.ts
 * QC LiDAR / MNT Explorer — Agent local FastAPI v3
 *
 * Correctif de compatibilité App.tsx.
 *
 * Cette version restaure les signatures attendues par ton App.tsx actuel :
 * - pingLocalAgent() retourne { service, version, ok }
 * - LocalAgentJobStatus est un OBJET de progression, pas une union string
 * - buildLocalExportJob(...) crée directement le job côté agent et retourne { job_id, ... }
 * - paramètres UI historiques conservés : outputDir, retryCount, requestTimeoutSeconds,
 *   metadataDatasetName, keepDownloadedFiles, etc.
 *
 * Endpoints agent :
 * - GET  /health ou /docs fallback
 * - POST /jobs-v3
 * - GET  /jobs-v3/{job_id}
 * - POST /jobs-v3/{job_id}/cancel
 */

export type LocalAgentJobState =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LocalAgentJobPhase =
  | "queued"
  | "prepare"
  | "estimate"
  | "download"
  | "downloading"
  | "zip"
  | "finalizing"
  | "done"
  | "init"
  | string;

export interface LocalAgentExportSettings {
  enabled: boolean;
  baseUrl: string;

  // Réglages réseau/export
  concurrency: number;
  networkProfile: "wifi" | "lan" | "advanced";
  pollingIntervalMs: number;
  requestTimeoutSeconds: number;
  timeoutSeconds: number;
  retryCount: number;

  // Réglages de sortie
  outputDir: string;
  keepDownloadedFiles: boolean;

  // Métadonnées
  metadataDatasetName: string | null;
}

export type LocalAgentUiSettings = LocalAgentExportSettings;

export const DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS: LocalAgentExportSettings = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8787",

  concurrency: 6,
  networkProfile: "wifi",
  pollingIntervalMs: 500,
  requestTimeoutSeconds: 60,
  timeoutSeconds: 60,
  retryCount: 2,

  outputDir: "C:/HQ/exports",
  keepDownloadedFiles: true,

  metadataDatasetName: null,
};

export interface LocalAgentHealth {
  ok: boolean;
  service: string;
  version: string;
  baseUrl?: string;
  message?: string;
}

export interface LocalAgentFileItem {
  url: string;
  dest_path: string;
  size?: number | null;
  filename?: string;
  name?: string;
}

export interface LocalAgentExportJobRequest {
  /**
   * Compatibilité App.tsx :
   * App.tsx lit job.job_id avant l'appel à createLocalExportJob(job).
   * À cette étape, le vrai job_id n'existe pas encore côté agent.
   * Il sera remplacé par created.job_id après POST /jobs-v3 si App.tsx le fait déjà.
   */
  job_id: string;

  files: LocalAgentFileItem[];
  concurrency: number;
  output_dir: string;
  metrics_path?: string | null;
  timeout_s: number;

  // Champs tolérants pour compatibilité avec versions précédentes
  aoi?: unknown;
  dataset?: string;
  dataset_name?: string | null;
  keep_downloaded_files?: boolean;
  retry_count?: number;
  network_profile?: "wifi" | "lan" | "advanced";
}

export interface LocalAgentCreateJobResponse {
  job_id: string;
}

export interface LocalAgentJobStatus {
  job_id: string;
  status: LocalAgentJobState;
  phase: LocalAgentJobPhase;

  percent: number;

  completed: number;
  total: number;

  downloaded_count: number;
  failed_count: number;

  current_file?: string | null;

  elapsed_ms: number;
  eta_ms?: number;

  bytes_downloaded: number;
  bytes_total_estimated: number;

  avg_speed_mbps?: number;
  avg_speed_mb_s?: number;

  output_dir?: string;
  metrics_path?: string | null;
  zip_path?: string | null;

  message?: string | null;
}

export interface BuildLocalExportJobInput {
  // Champs utilisés par App.tsx actuel
  aoi?: unknown;
  tiles?: Array<Record<string, unknown>>;
  selectedTiles?: Array<Record<string, unknown>>;
  selectedTileUrls?: string[];
  urls?: string[];
  files?: Array<{
    url: string;
    filename?: string;
    name?: string;
    dest_path?: string;
    size?: number | null;
  }>;

  dataset?: string;
  datasetName?: string;
  outputDir?: string;
  metricsPath?: string | null;

  settings?: Partial<LocalAgentExportSettings>;

  // Tolérance maximale pour éviter les ruptures TS lors des refactors UI
  [key: string]: unknown;
}

export class LocalAgentError extends Error {
  status?: number;
  details?: unknown;

  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "LocalAgentError";
    this.status = status;
    this.details = details;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS.baseUrl).replace(/\/+$/, "");
}

function getRequestTimeoutMs(settings?: Partial<LocalAgentExportSettings>): number {
  const seconds =
    settings?.requestTimeoutSeconds ??
    settings?.timeoutSeconds ??
    DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS.requestTimeoutSeconds;

  return Math.max(1, seconds) * 1000;
}

function getFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || "download.bin");
  } catch {
    const last = url.split("?")[0].split("/").filter(Boolean).pop();
    return last || "download.bin";
  }
}

function joinPath(base: string, child: string): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanChild = child.replace(/^[\\/]+/, "");
  return `${cleanBase}/${cleanChild}`;
}

function createTimeoutSignal(ms: number): AbortController {
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller;
}

function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30000,
): Promise<T> {
  const timeoutController = createTimeoutSignal(timeoutMs);
  const signal = init.signal
    ? mergeAbortSignals(init.signal, timeoutController.signal)
    : timeoutController.signal;

  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await parseBody(response);

  if (!response.ok) {
    throw new LocalAgentError(
      `Erreur agent local HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  return body as T;
}

function extractUrlFromTile(tile: Record<string, unknown>): string | null {
  const props =
    tile.properties && typeof tile.properties === "object"
      ? (tile.properties as Record<string, unknown>)
      : {};

  const candidates = [
    tile.url,
    tile.download_url,
    tile.downloadUrl,
    tile.href,
    tile.laz_url,
    tile.lidar_url,
    tile.mnt_url,
    tile.source_url,

    props.url,
    props.URL,
    props.Url,
    props.download_url,
    props.downloadUrl,
    props.DOWNLOAD_URL,
    props.href,
    props.HREF,
    props.laz_url,
    props.LAZ_URL,
    props.lidar_url,
    props.LIDAR_URL,
    props.mnt_url,
    props.MNT_URL,
    props.source_url,
    props.SOURCE_URL,
    props.file_url,
    props.FILE_URL,
    props.telechargement,
    props.TELECHARGEMENT,
    props.download,
    props.DOWNLOAD,
    props.lien,
    props.LIEN,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  // Recherche de secours : plusieurs index de tuiles exposent l’URL
  // sous un nom métier variable. On accepte toute propriété string HTTP(S)
  // qui ressemble à un livrable LiDAR/MNT téléchargeable.
  const allValues = [
    ...Object.values(tile),
    ...Object.values(props),
  ];

  for (const value of allValues) {
    if (typeof value !== "string") continue;
    const v = value.trim();
    if (!/^https?:\/\//i.test(v)) continue;

    const lower = v.toLowerCase();
    if (
      lower.includes(".laz") ||
      lower.includes(".las") ||
      lower.includes(".zip") ||
      lower.includes(".tif") ||
      lower.includes(".tiff") ||
      lower.includes("lidar") ||
      lower.includes("mnt")
    ) {
      return v;
    }
  }

  return null;
}

function normalizeFiles(input: BuildLocalExportJobInput, outputDir: string): LocalAgentFileItem[] {
  const normalized: LocalAgentFileItem[] = [];

  if (input.files && input.files.length > 0) {
    for (const file of input.files) {
      const filename = file.filename || file.name || getFileNameFromUrl(file.url);
      normalized.push({
        url: file.url,
        dest_path: file.dest_path || joinPath(outputDir, filename),
        size: file.size ?? null,
      });
    }
    return normalized;
  }

  if (input.urls && input.urls.length > 0) {
    for (const url of input.urls) {
      normalized.push({
        url,
        dest_path: joinPath(outputDir, getFileNameFromUrl(url)),
        size: null,
      });
    }
    return normalized;
  }

  if (input.selectedTileUrls && input.selectedTileUrls.length > 0) {
    for (const url of input.selectedTileUrls) {
      normalized.push({
        url,
        dest_path: joinPath(outputDir, getFileNameFromUrl(url)),
        size: null,
      });
    }
    return normalized;
  }

  const tileArrays = [input.selectedTiles, input.tiles];

  for (const arr of tileArrays) {
    if (!arr || arr.length === 0) continue;

    for (const tile of arr) {
      const url = extractUrlFromTile(tile);
      if (!url) continue;

      const props =
        tile.properties && typeof tile.properties === "object"
          ? (tile.properties as Record<string, unknown>)
          : {};

      const filename =
        typeof tile.filename === "string"
          ? tile.filename
          : typeof tile.name === "string"
            ? tile.name
            : typeof props.filename === "string"
              ? props.filename
              : typeof props.name === "string"
                ? props.name
                : typeof props.NOM === "string"
                  ? props.NOM
                  : getFileNameFromUrl(url);

      const size =
        typeof tile.size === "number"
          ? tile.size
          : typeof tile.bytes === "number"
            ? tile.bytes
            : typeof props.size === "number"
              ? props.size
              : typeof props.bytes === "number"
                ? props.bytes
                : null;

      normalized.push({
        url,
        dest_path: joinPath(outputDir, filename),
        size,
      });
    }

    if (normalized.length > 0) return normalized;
  }

  return normalized;
}

/**
 * Ping robuste.
 * Retourne un objet, car App.tsx lit health.service et health.version.
 */
export async function pingLocalAgent(
  settings: Partial<LocalAgentExportSettings> = {},
): Promise<LocalAgentHealth> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const timeoutMs = 3000;

  try {
    try {
      const health = await requestJson<Partial<LocalAgentHealth>>(
        `${baseUrl}/health`,
        { method: "GET" },
        timeoutMs,
      );

      return {
        ok: health.ok ?? true,
        service: health.service ?? "QC LiDAR Agent",
        version: health.version ?? "v3",
        baseUrl,
        message: health.message,
      };
    } catch {
      const controller = createTimeoutSignal(timeoutMs);
      const response = await fetch(`${baseUrl}/docs`, {
        method: "GET",
        signal: controller.signal,
      });

      return {
        ok: response.ok,
        service: "QC LiDAR Agent",
        version: "v3",
        baseUrl,
      };
    }
  } catch {
    return {
      ok: false,
      service: "QC LiDAR Agent",
      version: "indisponible",
      baseUrl,
      message: "Agent local non joignable.",
    };
  }
}

/**
 * Construit le payload /jobs-v3 sans appeler l’agent.
 * Utile si App.tsx veut seulement préparer la requête.
 */
export function buildLocalExportJobPayload(
  input: BuildLocalExportJobInput,
): LocalAgentExportJobRequest {
  const settings = {
    ...DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
    ...(input.settings ?? {}),
  };

  const outputDir =
    input.outputDir ||
    settings.outputDir ||
    DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS.outputDir;

  const files = normalizeFiles(input, outputDir);

  if (!files.length) {
    throw new LocalAgentError(
      "Aucune URL de tuile détectée. Vérifie que les tuiles sélectionnées contiennent un champ url/download_url.",
    );
  }

  return {
    job_id: "",
    files,
    concurrency: settings.concurrency,
    output_dir: outputDir,
    metrics_path: input.metricsPath ?? joinPath(outputDir, "metrics.json"),
    timeout_s: settings.requestTimeoutSeconds ?? settings.timeoutSeconds,
    aoi: input.aoi,
    dataset: input.dataset,
    dataset_name: input.datasetName ?? settings.metadataDatasetName,
    keep_downloaded_files: settings.keepDownloadedFiles,
    retry_count: settings.retryCount,
    network_profile: settings.networkProfile,
  };
}

/**
 * Fonction attendue par App.tsx actuel :
 * elle construit seulement le payload. App.tsx appelle ensuite createLocalExportJob(job).
 */
export function buildLocalExportJob(
  input: BuildLocalExportJobInput,
): LocalAgentExportJobRequest {
  return buildLocalExportJobPayload(input);
}

/**
 * Crée un job async côté agent.
 */
export async function createLocalExportJob(
  job: LocalAgentExportJobRequest,
  settings: Partial<LocalAgentExportSettings> = {},
  signal?: AbortSignal,
): Promise<LocalAgentCreateJobResponse> {
  const mergedSettings = {
    ...DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
    ...settings,
  };

  const baseUrl = normalizeBaseUrl(mergedSettings.baseUrl);

  const response = await requestJson<LocalAgentCreateJobResponse>(
    `${baseUrl}/jobs-v3`,
    {
      method: "POST",
      body: JSON.stringify(job),
      signal,
    },
    getRequestTimeoutMs(mergedSettings),
  );

  if (!response.job_id) {
    throw new LocalAgentError("L’agent local n’a pas retourné de job_id.");
  }

  return response;
}

/**
 * Lit la progression réelle du job.
 */
export async function getLocalExportJobStatus(
  jobId: string,
  settings: Partial<LocalAgentExportSettings> = {},
  signal?: AbortSignal,
): Promise<LocalAgentJobStatus> {
  if (!jobId) {
    throw new LocalAgentError("job_id manquant.");
  }

  const mergedSettings = {
    ...DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
    ...settings,
  };

  const baseUrl = normalizeBaseUrl(mergedSettings.baseUrl);

  const raw = await requestJson<Partial<LocalAgentJobStatus>>(
    `${baseUrl}/jobs-v3/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      signal,
    },
    getRequestTimeoutMs(mergedSettings),
  );

  const avgMbS =
    typeof raw.avg_speed_mb_s === "number"
      ? raw.avg_speed_mb_s
      : typeof raw.avg_speed_mbps === "number"
        ? raw.avg_speed_mbps / 8
        : 0;

  return {
    job_id: raw.job_id ?? jobId,
    status: raw.status ?? "running",
    phase: raw.phase ?? "downloading",

    percent: raw.percent ?? 0,

    completed: raw.completed ?? 0,
    total: raw.total ?? 0,

    downloaded_count: raw.downloaded_count ?? 0,
    failed_count: raw.failed_count ?? 0,

    current_file: raw.current_file ?? null,

    elapsed_ms: raw.elapsed_ms ?? 0,
    eta_ms: raw.eta_ms ?? undefined,

    bytes_downloaded: raw.bytes_downloaded ?? 0,
    bytes_total_estimated: raw.bytes_total_estimated ?? 0,

    avg_speed_mb_s: avgMbS,
    avg_speed_mbps:
      typeof raw.avg_speed_mbps === "number"
        ? raw.avg_speed_mbps
        : Number((avgMbS * 8).toFixed(2)),

    output_dir: raw.output_dir,
    metrics_path: raw.metrics_path ?? null,
    zip_path: raw.zip_path ?? null,

    message: raw.message ?? null,
  };
}

/**
 * Annule proprement le job côté agent.
 */
export async function cancelLocalExportJob(
  jobId: string,
  settings: Partial<LocalAgentExportSettings> = {},
  signal?: AbortSignal,
): Promise<void> {
  if (!jobId) return;

  const mergedSettings = {
    ...DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
    ...settings,
  };

  const baseUrl = normalizeBaseUrl(mergedSettings.baseUrl);

  await requestJson<{ status: string }>(
    `${baseUrl}/jobs-v3/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    },
    getRequestTimeoutMs(mergedSettings),
  );
}

/**
 * Helpers UI.
 */
export function isLocalExportTerminal(status?: LocalAgentJobState | LocalAgentJobStatus | null): boolean {
  const value = typeof status === "string" ? status : status?.status;
  return value === "completed" || value === "failed" || value === "cancelled";
}

export function isLocalExportRunning(status?: LocalAgentJobState | LocalAgentJobStatus | null): boolean {
  const value = typeof status === "string" ? status : status?.status;
  return value === "pending" || value === "queued" || value === "running";
}

export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds} s`;
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatSpeedMBs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 MB/s";
  return `${value.toFixed(value >= 10 ? 1 : 2)} MB/s`;
}

// Alias conservés pour compatibilité avec les premiers fichiers générés.
export type AgentJobStatus = LocalAgentJobState;
export type AgentJobPhase = LocalAgentJobPhase;
export type AgentFileItem = LocalAgentFileItem;
export type CreateJobV3Request = LocalAgentExportJobRequest;
export type CreateJobV3Response = LocalAgentCreateJobResponse;
export type JobV3Progress = LocalAgentJobStatus;
