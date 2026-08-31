import { defineConfig, devices } from "@playwright/test";

const port = 4173;
const baseURL = process.env.VIDEOFLOW_BASE_URL ?? `http://127.0.0.1:${port}/VideoFlow/`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    serviceWorkers: "allow",
  },
  webServer: process.env.VIDEOFLOW_BASE_URL
    ? undefined
    : {
        command: `node scripts/serve-dist.mjs ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
