import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "声笺 · Personal Voice Reader",
    short_name: "声笺",
    description: "把文字交给熟悉的声音，随时连续聆听。",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f3ed",
    theme_color: "#1e654b",
    orientation: "portrait-primary",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
