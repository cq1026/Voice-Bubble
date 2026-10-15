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
    command: "npm run build && npm start",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    env: {
      PORT: "3100",
      PUBLIC_BASE_URL: "http://127.0.0.1:3100",
      HOST: "127.0.0.1",
      AUTH_MODE: "local",
      ENABLE_PAID_GENERATION: "false",
      ENABLE_TEST_HOST: "true",
      BUILD_TEST_HOST: "true",
      DATA_DIR: ".data/browser-tests",
    },
    timeout: 60_000,
  },
});
