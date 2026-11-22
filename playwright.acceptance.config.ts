import { defineConfig, devices } from "@playwright/test";

// The acceptance suite (Cycle 5): the end-to-end and negative cases of tests/acceptance, through the UI, on the production build.
// `npm run acceptance` runs it and writes test-results/acceptance-report.json and .md.
export default defineConfig({
  testDir: "tests/acceptance",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["json", { outputFile: "test-results/acceptance-raw.json" }], ["list"]],
  outputDir: "test-results/acceptance-artifacts",
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
