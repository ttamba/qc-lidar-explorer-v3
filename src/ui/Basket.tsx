import type { TileFeature } from "../types";

function getTileId(tile: TileFeature): string {
  const p = tile.properties as Record<string, any>;
  return String(p.tile_id ?? p.NOM_TUILE ?? "unknown");
}

function getTileUrl(tile: TileFeature): string {
  const p = tile.properties as Record<string, any>;
  return String(
    p.url ??
      p.download_url ??
      p.TELECHARGEMENT_TUILE ??
      p.telechargement_tuile ??
      ""
  );
}

function getProduct(tile: TileFeature): string {
  const p = tile.properties as Record<string, any>;
  return String(p.product ?? "").toLowerCase();
}

export default function Basket({ tiles }: { tiles: TileFeature[] }) {
  if (!tiles || tiles.length === 0) {
    return <div className="small">Aucune tuile sélectionnée.</div>;
  }

  return (
    <div style={{ maxHeight: 220, overflow: "auto" }}>
      {tiles.slice(0, 50).map((t, i) => {
        const tileId = getTileId(t);
        const product = getProduct(t);
        const url = getTileUrl(t);

        return (
          <div key={`${product}-${tileId}-${i}`} className="small">
            <strong>{tileId}</strong> — {product || "unknown"} —{" "}
            <span title={url || "URL non disponible"}>
              {url ? (url.length > 40 ? url.slice(0, 40) + "…" : url) : "URL non disponible"}
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