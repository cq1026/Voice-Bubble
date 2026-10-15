import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 600, height: 140 },
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev:test",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
