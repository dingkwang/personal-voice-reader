import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1e654b", borderRadius: 112 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        {[92, 190, 138, 70].map((height, index) => (
          <div key={index} style={{ width: 22, height, borderRadius: 20, background: "#fffdfa" }} />
        ))}
      </div>
    </div>,
    size,
  );
}
