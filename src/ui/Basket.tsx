import type { TileFeature } from "../types";
import { normalizeTile } from "../utils/normalizeTile";

type BasketProps = {
  tiles: TileFeature[];
};

function getProductBadgeStyle(product: string): React.CSSProperties {
  const value = product.toLowerCase();

  if (value === "lidar") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "3px 8px",
      borderRadius: 999,
      border: "1px solid #bfdbfe",
      background: "#eff6ff",
      color: "#1d4ed8",
      fontSize: 11,
      fontWeight: 700,
      lineHeight: 1.2,
    };
  }

  if (value === "mnt") {
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "3px 8px",
      borderRadius: 999,
      border: "1px solid #bbf7d0",
      background: "#f0fdf4",
      color: "#166534",
      fontSize: 11,
      fontWeight: 700,
      lineHeight: 1.2,
    };
  }

  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    color: "#4b5563",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.2,
  };
}

function truncateMiddle(value: string, maxLength = 56): string {
  if (value.length <= maxLength) return value;
  const side = Math.max(10, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

export default function Basket({ tiles }: BasketProps) {
  if (!tiles || tiles.length === 0) {
    return (
      <div
        style={{
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px dashed #d1d5db",
          background: "#f9fafb",
          fontSize: 12,
          lineHeight: 1.5,
          color: "#6b7280",
        }}
      >
        Aucune tuile retenue pour le moment.
      </div>
    );
  }

  const visibleTiles = tiles.slice(0, 50);

  return (
    <div>
      <div
        style={{
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {tiles.length} tuile{tiles.length > 1 ? "s" : ""} retenue{tiles.length > 1 ? "s" : ""}
        </div>

        {tiles.length > 50 && (
          <div style={{ fontSize: 11, color: "#6b7280" }}>
            Affichage des 50 premières tuiles
          </div>
        )}
      </div>

      <div
        style={{
          maxHeight: 280,
          overflowY: "auto",
          display: "grid",
          gap: 8,
          paddingRight: 2,
        }}
      >
        {visibleTiles.map((tile, index) => {
          const t = normalizeTile(tile);
          const productLabel = (t.product || "inconnu").toUpperCase();

          return (
            <div
              key={`${t.product}-${t.id}-${index}`}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #e5e7eb",
                background: "#ffffff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#111827",
                    lineHeight: 1.35,
                    wordBreak: "break-word",
                  }}
                >
                  {t.name || t.id || "Tuile sans nom"}
                </div>

                <span style={getProductBadgeStyle(t.product || "")}>{productLabel}</span>
              </div>

              <div style={{ display: "grid", gap: 6 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "#6b7280",
                    lineHeight: 1.35,
                  }}
                >
                  <span style={{ fontWeight: 700, color: "#4b5563" }}>ID :</span>{" "}
                  <span style={{ wordBreak: "break-word" }}>{t.id || "N/D"}</span>
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: "#6b7280",
                    lineHeight: 1.35,
                  }}
                  title={t.url || "URL non disponible"}
                >
                  <span style={{ fontWeight: 700, color: "#4b5563" }}>URL :</span>{" "}
                  {t.url ? truncateMiddle(t.url) : "URL non disponible"}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {tiles.length > 50 && (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "#6b7280",
            lineHeight: 1.4,
          }}
        >
          … {tiles.length - 50} autre{tiles.length - 50 > 1 ? "s" : ""} tuile
          {tiles.length - 50 > 1 ? "s" : ""} non affichée{tiles.length - 50 > 1 ? "s" : ""}.
        </div>
      )}
    </div>
  );
}
