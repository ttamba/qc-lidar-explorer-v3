export type PackageMode = "lean" | "full";
export type OutputMode = "zip" | "folder";

export type LocalAgentTile = {
  id?: string;
  url: string;
  filename?: string;
  product?: string;
  year?: string | number;
  properties?: Record<string, unknown>;
};

export type LocalExportRequest = {
  tiles: LocalAgentTile[];
  aoi?: GeoJSON.FeatureCollection | GeoJSON.Feature | null;
  selected_tiles_geojson?: GeoJSON.FeatureCollection | null;
  packageMode: PackageMode;
  outputMode: OutputMode;
  keep_downloaded_files?: boolean;
  max_workers?: number;
  export_name?: string;
  include_debug_files?: boolean;
};

export type LocalExportResponse = {
  ok: boolean;
  outputMode: OutputMode;
  packageMode: PackageMode;
  export_id: string;
  export_dir: string;
  folder_path?: string | null;
  zip_path?: string | null;
  download_url?: string | null;
  elapsed_seconds: number;
  downloaded_count: number;
  failed_count: number;
  logs: string[];
};

const LOCAL_AGENT_BASE_URL = "http://127.0.0.1:8765";

export async function checkLocalAgent(): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_AGENT_BASE_URL}/health`);
    if (!response.ok) return false;

    const data = await response.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

export async function exportWithLocalAgent(
  payload: LocalExportRequest
): Promise<LocalExportResponse> {
  const response = await fetch(`${LOCAL_AGENT_BASE_URL}/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      outputMode: payload.outputMode ?? "zip",
      packageMode: payload.packageMode ?? "lean",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Erreur agent local ${response.status}: ${text}`);
  }

  return response.json();
}

export function openAgentDownloadUrl(response: LocalExportResponse): void {
  if (response.outputMode !== "zip") return;
  if (!response.download_url) return;

  window.open(response.download_url, "_blank", "noopener,noreferrer");
}