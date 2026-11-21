import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { CONTENT_SECURITY_POLICY } from "./config/csp.ts";
import { resolve } from "node:path";
import { checkPack, fixtureDir, packDir, readPack } from "./config/contractPack.ts";

/** Adds the content security policy to the built page only, so the dev server's HMR websocket keeps working. */
const contentSecurityPolicy = (): Plugin => ({
  name: "dpp-content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
      injectTo: "head-prepend",
    },
  ],
});

/**
 * Embeds the frozen contract pack as `virtual:contract-pack` (Cycle 1, C1-02). The checker runs first, so
 * an unresolved term, a moving version or a changed file fails the build; the app then verifies every
 * digest again when it loads the pack.
 */
const contractPack = (): Plugin => {
  const id = "virtual:contract-pack";
  const dir = packDir();
  return {
    name: "dpp-contract-pack",
    buildStart() {
      try {
        checkPack(dir);
      } catch (error) {
        const out = (error as { stderr?: string; stdout?: string }).stderr || (error as Error).message;
        this.error(`contract pack ${dir} failed its check:\n${out}`);
      }
    },
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      const pack = readPack(dir);
      for (const path of [...Object.keys(pack.files), "MANIFEST.json"]) this.addWatchFile(`${dir}/${path}`);
      return `export default ${JSON.stringify({ ...pack, packDir: dir })};`;
    },
  };
};

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; the workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  plugins: [
    contentSecurityPolicy(),
    contractPack(),
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
  // The Import screen's sample files are the fixtures that match the embedded contract pack.
  resolve: { alias: { "@n-fixtures": resolve(fixtureDir()) } },
  build: {
    // Sample fixtures are fetched by the Import screen; a data: URL would be refused by connect-src 'self'.
    assetsInlineLimit: (file) => (file.includes("/fixtures/") ? false : undefined),
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
