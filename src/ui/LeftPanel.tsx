import { useEffect, useState } from "react";
import type { AoiFeature, BasemapConfig, TileFeature } from "../types";
import { importAoiFromFile } from "../aoi/importAoi";
import { validateAoi } from "../aoi/validate";
import LayerSwitcher from "./LayerSwitcher";
import Basket from "./Basket";

type Props = {
  basemaps: BasemapConfig | null;
  onBasemapsLoaded: (cfg: BasemapConfig) => void;

  aoi: AoiFeature | null;
  onAoiChange: (aoi: AoiFeature | null) => void;

  selectedTiles: TileFeature[];
  stats: { total: number; lidar: number; mnt: number };

  showLidar: boolean;
  showMnt: boolean;
  onToggleLidar: (v: boolean) => void;
  onToggleMnt: (v: boolean) => void;

  onExport: () => void;
  onClearSelection: () => void;
};

export default function LeftPanel(props: Props) {
  const [aoiError, setAoiError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}basemaps.json`);
      const cfg = (await res.json()) as BasemapConfig;
      props.onBasemapsLoaded(cfg);
    })().catch(() => {
      // silence; panel will work without basemap config
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPickFile(file: File) {
    setAoiError(null);
    try {
      const geo = await importAoiFromFile(file);
      const aoi = validateAoi(geo);
      props.onAoiChange(aoi);
    } catch (e: any) {
      setAoiError(e?.message ?? "Erreur import AOI.");
    }
  }

  return (
    <div className="panel">
      <div className="section">
        <div className="h1">QC LiDAR / MNT Explorer (MVP)</div>
        <div className="small">
          MVP statique : AOI → sélection tuiles → export (QGIS).
        </div>
      </div>

      <div className="section card">
        <div className="h1">Couches</div>
        <LayerSwitcher
          basemaps={props.basemaps}
          showLidar={props.showLidar}
          showMnt={props.showMnt}
          onToggleLidar={props.onToggleLidar}
          onToggleMnt={props.onToggleMnt}
        />
      </div>

      <div className="section card">
        <div className="h1">AOI (zone d’étude)</div>
        <div className="small">Formats : GeoJSON, KML, KMZ, Shapefile (.zip).</div>
        <input
          type="file"
          accept=".geojson,.json,.kml,.kmz,.zip"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickFile(f);
          }}
        />
        {props.aoi ? (
          <div style={{ marginTop: 10 }} className="row">
            <span className="badge">AOI chargée</span>
            <button className="btn" onClick={() => props.onAoiChange(null)}>
              Retirer AOI
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 10 }} className="small">
            Charge une AOI pour activer la sélection.
          </div>
        )}
        {aoiError && (
          <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>
            {aoiError}
          </div>
        )}
      </div>

      <div className="section card">
        <div className="h1">Sélection</div>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="badge">Total: {props.stats.total}</span>
          <span className="badge">LiDAR: {props.stats.lidar}</span>
          <span className="badge">MNT: {props.stats.mnt}</span>
        </div>

        <div className="row">
          <button
            className="btn primary"
            onClick={props.onExport}
            disabled={!props.aoi || props.selectedTiles.length === 0}
          >
            Exporter (ZIP)
          </button>
          <button
            className="btn"
            onClick={props.onClearSelection}
            disabled={props.selectedTiles.length === 0}
          >
            Vider la sélection
          </button>
        </div>

        <div style={{ marginTop: 10 }}>
          <Basket tiles={props.selectedTiles} />
        </div>
      </div>

      <div className="section small">
        Astuce perf : zoome sur ta zone avant de charger l’index (chunks).
      </div>
    </div>
  );
}
