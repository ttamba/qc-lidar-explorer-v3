import type { BasemapConfig } from "../types";

type Props = {
  basemaps: BasemapConfig | null;
  showLidar: boolean;
  showMnt: boolean;
  onToggleLidar: (v: boolean) => void;
  onToggleMnt: (v: boolean) => void;
};

export default function LayerSwitcher(props: Props) {
  const baseLabel = props.basemaps?.basemaps?.[0]?.label ?? "Basemap";

  return (
    <div>
      <div className="small" style={{ marginBottom: 8 }}>
        Fond : {baseLabel}
      </div>

      <label className="row" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={props.showLidar}
          onChange={(e) => props.onToggleLidar(e.target.checked)}
        />
        <span>Empreintes LiDAR (index chunké)</span>
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={props.showMnt}
          onChange={(e) => props.onToggleMnt(e.target.checked)}
        />
        <span>Empreintes MNT (index chunké)</span>
      </label>
    </div>
  );
}
