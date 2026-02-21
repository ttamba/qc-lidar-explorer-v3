import type { TileFeature } from "../types";

export default function Basket({ tiles }: { tiles: TileFeature[] }) {
  if (tiles.length === 0) return <div className="small">Aucune tuile sélectionnée.</div>;

  return (
    <div style={{ maxHeight: 220, overflow: "auto" }}>
      {tiles.slice(0, 50).map((t) => (
        <div key={`${t.properties.product}-${t.properties.tile_id}`} className="small">
          <strong>{t.properties.tile_id}</strong> — {t.properties.product} —{" "}
          <span title={t.properties.url}>
            {t.properties.url.length > 40 ? t.properties.url.slice(0, 40) + "…" : t.properties.url}
          </span>
        </div>
      ))}
      {tiles.length > 50 && (
        <div className="small" style={{ marginTop: 6 }}>
          … {tiles.length - 50} autres
        </div>
      )}
    </div>
  );
}
