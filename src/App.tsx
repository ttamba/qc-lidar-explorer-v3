import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import MapView from "./map/MapView";
import Basket from "./ui/Basket";
import type { TileFeature, AoiFeature } from "./types";

import { importAoiFromFile } from "./aoi/importAoi";
import { validateAoi } from "./aoi/validate";
import {
  SUPPORTED_SOURCE_CRS,
  autoDetectSourceCrsFromGeoJson,
  reprojectGeoJsonToWgs84,
  type SupportedSourceCrsCode,
} from "./aoi/reprojectAoi";
import {
  exportBundle,
  type ExportMode,
  type ExportProgress,
} from "./export/exportBundle";
import {
  pingLocalAgent,
  createLocalExportJob,
  getLocalExportJobStatus,
  cancelLocalExportJob,
  buildLocalExportJob,
  DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
  type LocalAgentJobStatus,
  type LocalAgentExportSettings,
} from "./agent/localAgent";

type Dataset = "lidar" | "mnt";
type AvailableYears = { lidar: string[]; mnt: string[] };
type YearFilter = { lidar: string | "ALL"; mnt: string | "ALL" };
type StatusTone = "info" | "success" | "warning" | "error";

type LocalAgentUiSettings = LocalAgentExportSettings & {
  packageMode?: "lean" | "full";
};

type ExportUiState = {
  isOpen: boolean;
  phase: "idle" | "download" | "zip" | "done" | "error";
  percent: number;
  completed: number;
  total: number;
  currentFile?: string;
  message?: string;
  downloadedCount: number;
  failedCount: number;
  elapsedMs?: number;
  etaMs?: number;
  mode?: ExportMode;
};

const INITIAL_EXPORT_UI_STATE: ExportUiState = {
  isOpen: false,
  phase: "idle",
  percent: 0,
  completed: 0,
  total: 0,
  currentFile: undefined,
  message: undefined,
  downloadedCount: 0,
  failedCount: 0,
  elapsedMs: 0,
  etaMs: undefined,
  mode: undefined,
};

function getTileProduct(tile: TileFeature): Dataset | "" {
  const props = (tile?.properties ?? {}) as Record<string, unknown>;
  const raw =
    props.normalized_product ?? props.product ?? props.PRODUIT ?? props.type_produit ?? "";
  const value = String(raw).toLowerCase();

  if (value === "lidar") return "lidar";
  if (value === "mnt") return "mnt";
  return "";
}

function isWgs84ValidationError(message: string): boolean {
  return /WGS84|EPSG:4326/i.test(message);
}

function formatDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  return `${minutes} min ${seconds}s`;
}

function formatBytes(bytes?: number) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "Ko", "Mo", "Go", "To"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getStatusCardStyle(tone: StatusTone): CSSProperties {
  switch (tone) {
    case "success":
      return {
        border: "1px solid #86efac",
        background: "#f0fdf4",
        color: "#166534",
      };
    case "warning":
      return {
        border: "1px solid #fcd34d",
        background: "#fffbeb",
        color: "#92400e",
      };
    case "error":
      return {
        border: "1px solid #fca5a5",
        background: "#fef2f2",
        color: "#991b1b",
      };
    case "info":
    default:
      return {
        border: "1px solid #bfdbfe",
        background: "#eff6ff",
        color: "#1d4ed8",
      };
  }
}

function SectionCard(props: {
  title: string;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <section
      style={{
        marginTop: 14,
        padding: 14,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#ffffff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{props.title}</div>
        {props.subtitle && (
          <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
            {props.subtitle}
          </div>
        )}
      </div>
      {props.children}
    </section>
  );
}

function StatusCard(props: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 10,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        ...getStatusCardStyle(props.tone),
      }}
    >
      {props.children}
    </div>
  );
}

function SmallStat(props: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 10,
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
      }}
    >
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{props.label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{props.value}</div>
    </div>
  );
}

function ActionButton(props: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit" | "reset";
}) {
  const variant = props.variant ?? "secondary";

  let style: CSSProperties = {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#111827",
    cursor: props.disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
    fontSize: 13,
    opacity: props.disabled ? 0.6 : 1,
  };

  if (variant === "primary") {
    style = {
      ...style,
      border: "1px solid #2563eb",
      background: "#2563eb",
      color: "#ffffff",
    };
  }

  if (variant === "danger") {
    style = {
      ...style,
      border: "1px solid #dc2626",
      background: "#ffffff",
      color: "#b91c1c",
    };
  }

  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      style={style}
    >
      {props.children}
    </button>
  );
}

function ExportProgressCard(props: {
  state: ExportUiState;
  onClose: () => void;
}) {
  const { state, onClose } = props;

  if (!state.isOpen) return null;

  const phaseLabel =
    state.phase === "download"
      ? "Téléchargement"
      : state.phase === "zip"
        ? "Compression"
        : state.phase === "done"
          ? "Terminé"
          : state.phase === "error"
            ? "Erreur"
            : "Préparation";

  const barColor =
    state.phase === "error"
      ? "#dc2626"
      : state.phase === "done"
        ? "#16a34a"
        : "#2563eb";

  const modeLabel =
    state.mode === "inline-zip"
      ? "ZIP complet avec tuiles"
      : state.mode === "inventory-only"
        ? "ZIP d’inventaire + liens"
        : "Agent local";

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        border: "1px solid #dbeafe",
        background: "#ffffff",
        boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
      }}
      role="status"
      aria-live="polite"
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>
            Export bundle LiDAR / MNT
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#4b5563", lineHeight: 1.4 }}>
            {state.message ?? "Traitement en cours…"}
          </div>
        </div>

        {(state.phase === "done" || state.phase === "error" || state.phase === "idle") && (
          <ActionButton onClick={onClose} variant="secondary">
            Fermer
          </ActionButton>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: "#6b7280",
          marginBottom: 6,
        }}
      >
        <span>{phaseLabel}</span>
        <span>{Math.max(0, Math.min(100, state.percent))}%</span>
      </div>

      <div
        style={{
          width: "100%",
          height: 10,
          borderRadius: 999,
          background: "#e5e7eb",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, state.percent))}%`,
            height: "100%",
            background: barColor,
            transition: "width 220ms ease",
          }}
        />
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 6, fontSize: 12, color: "#4b5563" }}>
        <div>
          Progression : <strong>{state.completed}</strong> / <strong>{state.total}</strong>
        </div>

        <div>
          Incluses : <strong>{state.downloadedCount}</strong> · Échecs :{" "}
          <strong>{state.failedCount}</strong>
        </div>

        <div>
          Durée écoulée : <strong>{formatDuration(state.elapsedMs)}</strong>
        </div>

        {state.phase === "download" &&
          state.etaMs !== undefined &&
          state.completed > 0 &&
          state.completed < state.total && (
            <div>
              Temps restant estimé : <strong>{formatDuration(state.etaMs)}</strong>
            </div>
          )}

        <div>
          Mode : <strong>{modeLabel}</strong>
        </div>

        {state.currentFile && (
          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            Fichier en cours : <strong title={state.currentFile}>{state.currentFile}</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function toExportUiState(progress: ExportProgress): ExportUiState {
  return {
    isOpen: true,
    phase: progress.phase,
    percent: progress.percent,
    completed: progress.completed,
    total: progress.total,
    currentFile: progress.currentFile,
    message: progress.message,
    downloadedCount: progress.downloadedCount ?? 0,
    failedCount: progress.failedCount ?? 0,
    elapsedMs: progress.elapsedMs ?? 0,
    etaMs: progress.etaMs,
    mode: progress.mode,
  };
}

export default function App() {
  const [selectedTiles, setSelectedTiles] = useState<TileFeature[]>([]);
  const [aoi, setAoi] = useState<AoiFeature | null>(null);
  const [aoiError, setAoiError] = useState<string>("");

  const [pendingAoiRaw, setPendingAoiRaw] = useState<Record<string, unknown> | null>(null);
  const [pendingAoiFileName, setPendingAoiFileName] = useState<string>("");
  const [selectedSourceCrs, setSelectedSourceCrs] =
    useState<SupportedSourceCrsCode>("EPSG:32188");
  const [detectedSourceCrs, setDetectedSourceCrs] =
    useState<SupportedSourceCrsCode | null>(null);
  const [isReprojectingAoi, setIsReprojectingAoi] = useState(false);

  const [selectedProduct, setSelectedProduct] = useState<Dataset>("lidar");
  const [yearFilter, setYearFilter] = useState<YearFilter>({
    lidar: "ALL",
    mnt: "ALL",
  });
  const [availableYears, setAvailableYears] = useState<AvailableYears>({
    lidar: [],
    mnt: [],
  });

  const [loadingAoi, setLoadingAoi] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string>("");
  const [exportUi, setExportUi] = useState<ExportUiState>(INITIAL_EXPORT_UI_STATE);

  const [isLocalAgentReachable, setIsLocalAgentReachable] = useState<boolean | null>(null);
  const [localAgentInfo, setLocalAgentInfo] = useState<string>("");
  const [localExportJobId, setLocalExportJobId] = useState<string | null>(null);
  const [localAgentSettings, setLocalAgentSettings] = useState<LocalAgentUiSettings>({
    ...DEFAULT_LOCAL_AGENT_EXPORT_SETTINGS,
    packageMode: "lean",
  });

  const activeYears =
    selectedProduct === "lidar" ? availableYears.lidar : availableYears.mnt;
  const activeYear =
    selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;

  const activeSelectionCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === selectedProduct).length,
    [selectedProduct, selectedTiles]
  );

  const lidarCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === "lidar").length,
    [selectedTiles]
  );

  const mntCount = useMemo(
    () => selectedTiles.filter((tile) => getTileProduct(tile) === "mnt").length,
    [selectedTiles]
  );

  const totalSelectionCount = selectedTiles.length;
  const hasAoi = Boolean(aoi);
  const hasPendingReprojection = Boolean(pendingAoiRaw);
  const isBusy = loadingAoi || isReprojectingAoi || isExporting;
  const canExport = hasAoi && totalSelectionCount > 0 && !isBusy;
  const canClearAoi = (hasAoi || hasPendingReprojection || !!aoiError) && !isBusy;
  const canClearSelection = totalSelectionCount > 0 && !isBusy;

  const statusSummary = useMemo(() => {
    if (loadingAoi) {
      return { tone: "info" as StatusTone, message: "Chargement de la zone d’étude en cours…" };
    }
    if (isReprojectingAoi) {
      return { tone: "info" as StatusTone, message: "Reprojection automatique de l’AOI en cours…" };
    }
    if (isExporting) {
      return {
        tone: "info" as StatusTone,
        message: exportUi.message ?? "Préparation du bundle d’export en cours…",
      };
    }
    if (aoiError) {
      return { tone: "error" as StatusTone, message: aoiError };
    }
    if (hasPendingReprojection) {
      return {
        tone: "warning" as StatusTone,
        message:
          "Une AOI projetée a été détectée. Vérifiez le SCR source puis lancez la reprojection vers WGS84.",
      };
    }
    if (infoMessage) {
      return { tone: "success" as StatusTone, message: infoMessage };
    }
    if (hasAoi) {
      return {
        tone: "success" as StatusTone,
        message: "Zone d’étude chargée. La carte est prête pour l’exploration.",
      };
    }
    return {
      tone: "info" as StatusTone,
      message:
        "Importez une zone d’étude pour afficher les tuiles disponibles, filtrer les années et préparer l’export.",
    };
  }, [
    aoiError,
    exportUi.message,
    hasAoi,
    hasPendingReprojection,
    infoMessage,
    isExporting,
    isReprojectingAoi,
    loadingAoi,
  ]);

  useEffect(() => {
    let isMounted = true;

    async function checkAgent() {
      try {
        const health = await pingLocalAgent();
        if (!isMounted) return;
        setIsLocalAgentReachable(true);
        setLocalAgentInfo(`${health.service} v${health.version}`);
      } catch {
        if (!isMounted) return;
        setIsLocalAgentReachable(false);
        setLocalAgentInfo("");
      }
    }

    void checkAgent();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!localExportJobId) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const status: LocalAgentJobStatus = await getLocalExportJobStatus(localExportJobId);
        if (cancelled) return;

        const phase =
          status.phase === "queued" || status.phase === "prepare" || status.phase === "estimate"
            ? "download"
            : status.phase === "download"
              ? "download"
              : status.phase === "zip"
                ? "zip"
                : status.phase === "done"
                  ? "done"
                  : "error";

        const extraMessageParts: string[] = [];
        if (status.bytes_downloaded > 0) {
          extraMessageParts.push(`Téléchargé : ${formatBytes(status.bytes_downloaded)}`);
        }
        if (status.bytes_total_estimated > 0) {
          extraMessageParts.push(`Estimé : ${formatBytes(status.bytes_total_estimated)}`);
        }
        if (typeof status.avg_speed_mbps === "number") {
          extraMessageParts.push(`Débit moyen : ${status.avg_speed_mbps} Mb/s`);
        }

        setExportUi({
          isOpen: true,
          phase,
          percent: status.percent,
          completed: status.completed,
          total: status.total,
          currentFile: status.current_file ?? undefined,
          message:
            status.message ??
            (phase === "zip"
              ? "Création du ZIP final…"
              : "Téléchargement local en cours…"),
          downloadedCount: status.downloaded_count,
          failedCount: status.failed_count,
          elapsedMs: status.elapsed_ms,
          etaMs: status.eta_ms,
          mode: undefined,
        });

        if (extraMessageParts.length > 0 && status.status === "running") {
          setInfoMessage(extraMessageParts.join(" · "));
        }

        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "cancelled"
        ) {
          window.clearInterval(timer);

          if (status.status === "completed") {
            setInfoMessage(
              status.zip_path
                ? `Export local terminé. ZIP généré : ${status.zip_path}`
                : "Export local terminé."
            );
          } else if (status.status === "failed") {
            setAoiError(status.message ?? "Le job local a échoué.");
          } else {
            setInfoMessage("Export local annulé.");
          }

          setLocalExportJobId(null);
        }
      } catch (error) {
        if (cancelled) return;
        window.clearInterval(timer);
        setLocalExportJobId(null);
        setAoiError(
          error instanceof Error
            ? error.message
            : "Perte de communication avec l’agent local."
        );
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [localExportJobId]);

  function updateLocalAgentSettings(patch: Partial<LocalAgentUiSettings>) {
    setLocalAgentSettings((prev) => ({
      ...prev,
      ...patch,
    }));
  }

  async function handleAoiFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingAoi(true);
      setInfoMessage("");
      setAoiError("");
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);

      const geo = await importAoiFromFile(file);

      try {
        const valid = validateAoi(geo);
        setAoi(valid);
        setSelectedTiles([]);
        setAvailableYears({ lidar: [], mnt: [] });
        setInfoMessage(`Zone d’étude chargée avec succès : ${file.name}`);
        return;
      } catch (validationError: unknown) {
        const message =
          validationError instanceof Error
            ? validationError.message
            : "Erreur lors du chargement AOI";

        if (isWgs84ValidationError(message)) {
          const detected = autoDetectSourceCrsFromGeoJson(geo);
          setAoi(null);
          setSelectedTiles([]);
          setAvailableYears({ lidar: [], mnt: [] });
          setPendingAoiRaw(geo);
          setPendingAoiFileName(file.name);
          setDetectedSourceCrs(detected);
          setSelectedSourceCrs(detected ?? "EPSG:32188");
          setAoiError(
            detected
              ? `${message}

CRS suggéré automatiquement : ${detected}. Vérifiez au besoin puis lancez la reprojection vers WGS84.`
              : `${message}

Le fichier semble projeté. Choisissez le SCR source ci-dessous pour tenter une reprojection automatique vers WGS84.`
          );
          return;
        }

        throw validationError;
      }
    } catch (err: unknown) {
      setAoi(null);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);
      setInfoMessage("");
      setAoiError(err instanceof Error ? err.message : "Erreur lors du chargement AOI");
    } finally {
      setLoadingAoi(false);
      e.target.value = "";
    }
  }

  async function handleReprojectAndLoadAoi() {
    if (!pendingAoiRaw || isReprojectingAoi) return;

    try {
      setIsReprojectingAoi(true);
      setInfoMessage("");
      setAoiError("");

      const reprojected = reprojectGeoJsonToWgs84(pendingAoiRaw, selectedSourceCrs);
      const valid = validateAoi(reprojected);

      setAoi(valid);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setPendingAoiRaw(null);
      setPendingAoiFileName("");
      setDetectedSourceCrs(null);
      setAoiError("");
      setInfoMessage("AOI reprojetée et chargée avec succès.");
    } catch (err: unknown) {
      setAoi(null);
      setSelectedTiles([]);
      setAvailableYears({ lidar: [], mnt: [] });
      setInfoMessage("");
      setAoiError(
        err instanceof Error
          ? err.message
          : "La reprojection automatique a échoué. Vérifiez le SCR source choisi."
      );
    } finally {
      setIsReprojectingAoi(false);
    }
  }

  function clearAoi() {
    setAoi(null);
    setSelectedTiles([]);
    setAvailableYears({ lidar: [], mnt: [] });
    setAoiError("");
    setInfoMessage("");
    setPendingAoiRaw(null);
    setPendingAoiFileName("");
    setDetectedSourceCrs(null);
    setExportUi(INITIAL_EXPORT_UI_STATE);
  }

  function clearSelection() {
    setSelectedTiles([]);
    setInfoMessage("Sélection et export vidés.");
    setExportUi(INITIAL_EXPORT_UI_STATE);
  }

  function handleSelectedProductChange(product: Dataset) {
    setSelectedProduct(product);
    setSelectedTiles([]);
    setInfoMessage("");
  }

  function handleYearChange(value: string) {
    setYearFilter((prev) => ({
      ...prev,
      [selectedProduct]: value as YearFilter[Dataset],
    }));
    setSelectedTiles([]);
    setInfoMessage("");
  }

  function handleYearsChange(years: AvailableYears) {
    setAvailableYears(years);

    const nextYears = selectedProduct === "lidar" ? years.lidar : years.mnt;
    const currentYear =
      selectedProduct === "lidar" ? yearFilter.lidar : yearFilter.mnt;

    if (currentYear !== "ALL" && !nextYears.includes(currentYear)) {
      setYearFilter((prev) => ({
        ...prev,
        [selectedProduct]: "ALL",
      }));
    }
  }

  async function handleExport() {
    if (!canExport) return;

    try {
      setIsExporting(true);
      setInfoMessage("");
      setAoiError("");
      setExportUi({
        isOpen: true,
        phase: "download",
        percent: 0,
        completed: 0,
        total: selectedTiles.length,
        currentFile: undefined,
        message: "Préparation de l’export…",
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: 0,
        etaMs: undefined,
        mode: undefined,
      });

      await exportBundle({
        aoi,
        tiles: selectedTiles,
        onProgress: (progress) => {
          setExportUi(toExportUiState(progress));
        },
      });

      setInfoMessage("Export ZIP généré avec succès.");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Erreur lors de la création du bundle d’export.";
      setAoiError(message);
      setExportUi((prev) => ({
        ...prev,
        isOpen: true,
        phase: "error",
        message,
      }));
    } finally {
      setIsExporting(false);
    }
  }

  async function handleLocalExport() {
    if (!aoi || selectedTiles.length === 0) {
      window.alert("Aucune AOI ou aucune tuile sélectionnée.");
      return;
    }

    try {
      setInfoMessage("");
      setAoiError("");

      const job = buildLocalExportJob({
        aoi,
        tiles: selectedTiles,
        settings: localAgentSettings,
      });

      setExportUi({
        isOpen: true,
        phase: "download",
        percent: 0,
        completed: 0,
        total: selectedTiles.length,
        currentFile: undefined,
        message: "Création du job d’export local…",
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: 0,
        etaMs: undefined,
        mode: undefined,
      });

      const created = await createLocalExportJob(job);
      setLocalExportJobId(created.job_id);
      setInfoMessage("Job d’export local lancé.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Impossible de démarrer l’export local.";

      setAoiError(message);
      setExportUi({
        isOpen: true,
        phase: "error",
        percent: 0,
        completed: 0,
        total: selectedTiles.length,
        currentFile: undefined,
        message,
        downloadedCount: 0,
        failedCount: 0,
        elapsedMs: 0,
        etaMs: 0,
        mode: undefined,
      });
    }
  }

  async function handleCancelLocalExport() {
    if (!localExportJobId) return;

    try {
      await cancelLocalExportJob(localExportJobId);
      setInfoMessage("Demande d’annulation envoyée à l’agent local.");
    } catch (error) {
      setAoiError(
        error instanceof Error
          ? error.message
          : "Impossible d’annuler le job local."
      );
    }
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f3f4f6" }}>
      <aside
        style={{
          width: 400,
          padding: 14,
          borderRight: "1px solid #d1d5db",
          overflowY: "auto",
          background: "#f9fafb",
        }}
      >
        <div
          style={{
            padding: 14,
            borderRadius: 14,
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 19, fontWeight: 800, color: "#111827", marginBottom: 4 }}>
            QC LiDAR / MNT Explorer
          </div>
          <div style={{ fontSize: 13, color: "#4b5563", lineHeight: 1.45 }}>
            Préparation, lecture et export de tuiles LiDAR et MNT du Québec pour une zone d’étude.
          </div>

          <StatusCard tone={statusSummary.tone}>{statusSummary.message}</StatusCard>

          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              border: "1px solid #dbeafe",
              background: "#f8fbff",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 8px",
                borderRadius: 999,
                border: "1px solid #bfdbfe",
                background: "#eff6ff",
                color: "#1d4ed8",
                fontSize: 11,
                fontWeight: 800,
                marginBottom: 8,
              }}
            >
              Démo client
            </div>

            <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>
              Parcours recommandé : importer une zone d’étude, vérifier la sélection sur la carte,
              filtrer au besoin, puis exporter le panier.
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <SmallStat label="Produit actif" value={selectedProduct.toUpperCase()} />
            <SmallStat label="Année active" value={activeYear === "ALL" ? "Toutes" : activeYear} />
            <SmallStat label="Sélection active" value={activeSelectionCount} />
            <SmallStat label="Total sélectionné" value={totalSelectionCount} />
          </div>

          <ExportProgressCard
            state={exportUi}
            onClose={() => setExportUi(INITIAL_EXPORT_UI_STATE)}
          />
        </div>

        <SectionCard
          title="Zone d’étude"
          subtitle="Chargez une AOI pour lancer la lecture cartographique et activer la sélection."
        >
          <input
            type="file"
            onChange={handleAoiFile}
            disabled={isBusy || !!localExportJobId}
            style={{ width: "100%" }}
          />

          {pendingAoiRaw && (
            <StatusCard tone="warning">
              Une reprojection assistée est requise avant le chargement.
            </StatusCard>
          )}

          {!pendingAoiRaw && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ActionButton
                onClick={clearAoi}
                disabled={!canClearAoi || !!localExportJobId}
                variant="danger"
              >
                Effacer la zone d’étude
              </ActionButton>
            </div>
          )}

          {pendingAoiRaw && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 10,
                border: "1px solid #fcd34d",
                background: "#fffbeb",
                color: "#92400e",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Reprojection assistée</div>

              {pendingAoiFileName && (
                <div style={{ marginBottom: 8 }}>
                  <strong>Fichier :</strong> {pendingAoiFileName}
                </div>
              )}

              {detectedSourceCrs && (
                <div
                  style={{
                    marginBottom: 8,
                    padding: 8,
                    borderRadius: 8,
                    background: "#ecfccb",
                    border: "1px solid #84cc16",
                    color: "#365314",
                  }}
                >
                  <strong>CRS suggéré :</strong> {detectedSourceCrs}
                </div>
              )}

              <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
                SCR source
              </label>

              <select
                value={selectedSourceCrs}
                onChange={(e) => setSelectedSourceCrs(e.target.value as SupportedSourceCrsCode)}
                style={{
                  width: "100%",
                  marginBottom: 10,
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                }}
                disabled={isReprojectingAoi || !!localExportJobId}
              >
                {SUPPORTED_SOURCE_CRS.map((crs) => (
                  <option key={crs.code} value={crs.code}>
                    {crs.code} — {crs.label}
                  </option>
                ))}
              </select>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <ActionButton
                  onClick={handleReprojectAndLoadAoi}
                  disabled={isReprojectingAoi || !!localExportJobId}
                  variant="primary"
                >
                  {isReprojectingAoi ? "Reprojection..." : "Reprojeter et charger"}
                </ActionButton>

                <ActionButton
                  onClick={clearAoi}
                  disabled={isBusy || !!localExportJobId}
                  variant="secondary"
                >
                  Annuler
                </ActionButton>
              </div>

              <div style={{ marginTop: 8 }}>
                La reprojection cible toujours <strong>WGS84 (EPSG:4326)</strong>.
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Filtres"
          subtitle="Ajustez le produit et l’année pour affiner la lecture métier de la zone analysée."
        >
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#111827" }}>Produit actif</div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="selected-product"
                checked={selectedProduct === "lidar"}
                onChange={() => handleSelectedProductChange("lidar")}
                disabled={isBusy || !!localExportJobId}
              />
              LiDAR
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="radio"
                name="selected-product"
                checked={selectedProduct === "mnt"}
                onChange={() => handleSelectedProductChange("mnt")}
                disabled={isBusy || !!localExportJobId}
              />
              MNT
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: "#111827" }}>
              {selectedProduct === "lidar" ? "LiDAR" : "MNT"} — année
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="selected-year"
                checked={activeYear === "ALL"}
                onChange={() => handleYearChange("ALL")}
                disabled={isBusy || !!localExportJobId}
              />
              Toutes les années
            </label>

            {activeYears.map((year) => (
              <label key={year} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input
                  type="radio"
                  name="selected-year"
                  checked={activeYear === year}
                  onChange={() => handleYearChange(year)}
                  disabled={isBusy || !!localExportJobId}
                />
                {year}
              </label>
            ))}

            {activeYears.length === 0 && (
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>
                Aucune année disponible pour le produit actif dans la vue courante.
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Sélection et export navigateur"
          subtitle="Export direct dans le navigateur pour petits volumes ou inventaire pour gros volumes."
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            <SmallStat label="Total" value={totalSelectionCount} />
            <SmallStat label="LiDAR" value={lidarCount} />
            <SmallStat label="MNT" value={mntCount} />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ActionButton
              onClick={handleExport}
              disabled={!canExport || !!localExportJobId}
              variant="primary"
            >
              {isExporting ? "Export en cours..." : "Exporter (ZIP)"}
            </ActionButton>

            <ActionButton
              onClick={clearSelection}
              disabled={!canClearSelection || !!localExportJobId}
              variant="secondary"
            >
              Vider la sélection
            </ActionButton>
          </div>
        </SectionCard>

        <SectionCard
          title="Export local (agent)"
          subtitle="Transfert du travail lourd vers un agent local Windows pour les gros volumes."
        >
          <div style={{ display: "grid", gap: 10 }}>
            <StatusCard tone={isLocalAgentReachable ? "success" : "warning"}>
              {isLocalAgentReachable
                ? `Agent connecté : ${localAgentInfo}`
                : "Agent local non détecté sur http://127.0.0.1:8765"}
            </StatusCard>

            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
              Dossier de sortie local
              <input
                type="text"
                value={localAgentSettings.outputDir}
                onChange={(e) => updateLocalAgentSettings({ outputDir: e.target.value })}
                placeholder="C:\HQ\exports"
                style={{
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                }}
              />
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
                Concurrence
                <select
                  value={localAgentSettings.concurrency}
                  onChange={(e) => updateLocalAgentSettings({ concurrency: Number(e.target.value) })}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                  }}
                  disabled={!!localExportJobId}
                >
                  <option value={1}>1 — très prudent</option>
                  <option value={2}>2 — prudent</option>
                  <option value={3}>3 — recommandé</option>
                  <option value={4}>4 — rapide</option>
                  <option value={5}>5 — agressif</option>
                  <option value={6}>6 — agressif+</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
                Retries
                <select
                  value={localAgentSettings.retryCount}
                  onChange={(e) => updateLocalAgentSettings({ retryCount: Number(e.target.value) })}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                  }}
                  disabled={!!localExportJobId}
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
                Timeout (s)
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={localAgentSettings.requestTimeoutSeconds}
                  onChange={(e) =>
                    updateLocalAgentSettings({ requestTimeoutSeconds: Number(e.target.value) })
                  }
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                  }}
                  disabled={!!localExportJobId}
                />
              </label>

              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
                Jeu de données
                <input
                  type="text"
                  value={localAgentSettings.metadataDatasetName ?? ""}
                  onChange={(e) =>
                    updateLocalAgentSettings({ metadataDatasetName: e.target.value || null })
                  }
                  placeholder="Ex. LiDAR Québec 2021"
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                  }}
                  disabled={!!localExportJobId}
                />
              </label>
            </div>

            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "#374151" }}>
              Mode de packaging
              <select
                value={localAgentSettings.packageMode ?? "lean"}
                onChange={(e) =>
                  updateLocalAgentSettings({ packageMode: e.target.value as "lean" | "full" })
                }
                style={{
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                }}
                disabled={!!localExportJobId}
              >
                <option value="lean">Livrable (rapide)</option>
                <option value="full">Complet (debug)</option>
              </select>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#374151" }}>
              <input
                type="checkbox"
                checked={localAgentSettings.keepDownloadedFiles}
                onChange={(e) =>
                  updateLocalAgentSettings({ keepDownloadedFiles: e.target.checked })
                }
                disabled={!!localExportJobId}
              />
              Conserver aussi les fichiers intermédiaires sur disque
            </label>

            <StatusCard tone="info">
              Réglage actuel : concurrence <strong>{localAgentSettings.concurrency}</strong>,
              retries <strong>{localAgentSettings.retryCount}</strong>, timeout{" "}
              <strong>{localAgentSettings.requestTimeoutSeconds}s</strong>, packaging{" "}
              <strong>{localAgentSettings.packageMode ?? "lean"}</strong>, livrable{" "}
              <strong>{localAgentSettings.keepDownloadedFiles ? "ZIP + fichiers locaux" : "ZIP seul"}</strong>.
            </StatusCard>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ActionButton
                onClick={handleLocalExport}
                disabled={!isLocalAgentReachable || !aoi || selectedTiles.length === 0 || !!localExportJobId}
                variant="primary"
              >
                {localExportJobId ? "Export local en cours..." : "Lancer export local"}
              </ActionButton>

              <ActionButton
                onClick={handleCancelLocalExport}
                disabled={!localExportJobId}
                variant="danger"
              >
                Annuler
              </ActionButton>
            </div>

            {localExportJobId && (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                Job en cours : <strong>{localExportJobId}</strong>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Panier"
          subtitle="Inventaire synthétique des tuiles prêtes à être exportées."
        >
          <Basket tiles={selectedTiles} />
        </SectionCard>
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
        <MapView
          aoi={aoi}
          basemaps={null}
          selectedProduct={selectedProduct}
          yearFilter={yearFilter}
          onYearsChange={handleYearsChange}
          onSelectionChange={setSelectedTiles}
        />
      </main>
    </div>
  );
}
