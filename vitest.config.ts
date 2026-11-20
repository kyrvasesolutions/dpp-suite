import { defineConfig } from "vitest/config";

// Kept apart from vite.config.ts so unit tests don't load the PWA plugin.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "jsdom",
  },
});
