import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; the workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png", "logo.svg"],
      manifest: {
        name: "DPP Traceability",
        short_name: "DPP Trace",
        description: "Map product structure to digital product passport requirements.",
        lang: "en",
        display: "standalone",
        orientation: "any",
        background_color: "#f4f5f7",
        theme_color: "#f4f5f7",
        categories: ["business", "productivity"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell so it opens offline once installed.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
      },
    }),
  ],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
