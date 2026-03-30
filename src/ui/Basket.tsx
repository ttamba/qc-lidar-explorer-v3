import type { TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

export default function Basket({ tiles }: { tiles: TileFeature[] }) {
  if (!tiles || tiles.length === 0) {
    return <div className="small">Aucune tuile sélectionnée.</div>;
  }

  return (
    <div style={{ maxHeight: 220, overflow: "auto" }}>
      {tiles.slice(0, 50).map((tile, i) => {
        const t = normalizeTile(tile);

        return (
          <div key={`${t.product}-${t.id}-${i}`} className="small">
            <strong>{t.name}</strong> — {t.product || "unknown"} —{" "}
            <span title={t.url || "URL non disponible"}>
              {t.url ? (t.url.length > 40 ? t.url.slice(0, 40) + "…" : t.url) : "URL non disponible"}
            </span>
          </div>
        );
      })}

      {tiles.length > 50 && (
        <div className="small" style={{ marginTop: 6 }}>
          … {tiles.length - 50} autres
        </div>
      )}
    </div>
  );
}