import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "声笺 · Personal Voice Reader",
  description: "把文字和 TXT 变成可连续播放的个人声音。",
  applicationName: "声笺",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "声笺",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#1e654b",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
