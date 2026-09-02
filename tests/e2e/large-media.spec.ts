import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const large = join(root, "outputs", "certification", "large-3gb-4k-sparse.mp4");
const realLarge = process.env.VIDEOFLOW_LARGE_MEDIA_FIXTURE;

test.beforeAll(() => {
  if (process.env.VIDEOFLOW_LARGE_MEDIA_CERT === "1")
    execFileSync(process.execPath, [join(root, "scripts", "generate-certification-media.mjs")]);
  if (realLarge)
    execFileSync(process.execPath, [join(root, "scripts", "verify-real-large-media.mjs")], { env: process.env });
});

test("3 GiB 4K source uses session/reference architecture, proxy persistence and relink", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium" || process.env.VIDEOFLOW_LARGE_MEDIA_CERT !== "1", "Dedicated Chromium large-media certification only.");
  test.setTimeout(600_000);
  await page.goto("./");
  await page.getByTestId("media-import").setInputFiles(large);
  await expect(page.getByRole("dialog", { name: /Large Media Detected/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/3(?:\.0+)? GB|3 GiB/i)).toBeVisible();
  await page.getByRole("button", { name: "Session Only" }).click();
  await expect(page.getByText(/session-attached/i)).toBeVisible();

  await page.getByRole("button", { name: "Video Tools" }).click();
  await expect(page.getByRole("heading", { name: "large-3gb-4k-sparse.mp4", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Generate proxy/i }).click();
  await expect(page.getByRole("button", { name: /large-3gb-4k-sparse\.mp4.*Proxy ready/i })).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText(/Saved locally/)).toBeVisible({ timeout: 15_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Projects" }).click();
  await page.locator(".vf-project-grid article button").first().click();
  await page.getByRole("button", { name: "Video Tools" }).click();
  await expect(page.getByRole("button", { name: /large-3gb-4k-sparse\.mp4.*Proxy ready/i })).toBeVisible();

  await page.getByTestId("media-relink").setInputFiles(large);
  await expect(page.getByText(/original source.*relinked/i)).toBeVisible();

  await page.getByRole("button", { name: "Video Editor" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).last().click();
  await page.getByText("Export from (seconds)").locator("..").locator("input").fill("0");
  await page.getByText("Export to (seconds)").locator("..").locator("input").fill("1");
  await page.getByText("Preset").locator("..").locator("select").selectOption("youtube-4k");
  await page.getByRole("button", { name: /Add to queue/i }).click();
  await page.getByRole("button", { name: "Export Queue" }).click();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText(/3840×2160/)).toBeVisible();
});

test("genuine encoded large-media lifecycle uses bounded selected-range AI and preserves output", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium" || !realLarge, "Set VIDEOFLOW_LARGE_MEDIA_FIXTURE to a non-sparse encoded file for this certification.");
  test.setTimeout(3_600_000);
  const rangeStart = Number(process.env.VIDEOFLOW_LARGE_MEDIA_RANGE_START || 0);
  const rangeEnd = Number(process.env.VIDEOFLOW_LARGE_MEDIA_RANGE_END || rangeStart + 5);
  if (!(rangeEnd > rangeStart)) throw new Error("VIDEOFLOW_LARGE_MEDIA_RANGE_END must be greater than RANGE_START.");

  await page.goto("./");
  await page.getByTestId("media-import").setInputFiles(realLarge!);
  await expect(page.getByRole("dialog", { name: /Large Media Detected/i })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Session Only" }).click();
  await expect(page.getByText(/session-attached/i)).toBeVisible();
  const originUsage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
  expect(originUsage).toBeLessThan(512 * 1024 * 1024);

  await page.getByRole("button", { name: "Video Tools" }).click();
  await page.getByRole("button", { name: /Generate proxy/i }).click();
  await expect(page.getByText(/Proxy ready|Editing proxy ready/i)).toBeVisible({ timeout: 1_800_000 });
  await expect(page.getByText(/Saved locally/)).toBeVisible({ timeout: 30_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Projects" }).click();
  await page.locator(".vf-project-grid article button").first().click();
  await page.getByRole("button", { name: "Video Tools" }).click();
  await expect(page.getByText(/Proxy ready/)).toBeVisible();
  await page.getByTestId("media-relink").setInputFiles(realLarge!);
  await expect(page.getByText(/original source.*relinked/i)).toBeVisible();

  await page.getByRole("button", { name: "Video Editor" }).click();
  await page.locator(".vf-clip-video").first().click();
  await page.getByRole("button", { name: /Add region/i }).click();
  await page.getByRole("button", { name: /Install bundled AI/i }).click();
  await expect(page.getByText(/checksum verified/i)).toBeVisible({ timeout: 180_000 });
  await page.getByLabel("Region 1 method").selectOption("ai");
  await page.getByLabel("Tracking range start").fill(String(rangeStart));
  await page.getByLabel("Tracking range end").fill(String(rangeEnd));
  await page.getByRole("button", { name: /Track Selected Range/i }).click();
  await expect(page.getByText(/Tracking complete|paused.*correction/i)).toBeVisible({ timeout: 600_000 });

  await page.getByRole("button", { name: "Export", exact: true }).last().click();
  await page.getByText("Export from (seconds)").locator("..").locator("input").fill(String(rangeStart));
  await page.getByText("Export to (seconds)").locator("..").locator("input").fill(String(rangeEnd));
  await page.getByText("Preset").locator("..").locator("select").selectOption("youtube-4k");
  await page.getByRole("button", { name: /Add to queue/i }).click();
  await page.getByRole("button", { name: "Export Queue" }).click();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible({ timeout: 1_800_000 });
  await expect(page.getByText(/3840×2160/)).toBeVisible();

  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pendingDownload;
  const output = await download.path();
  expect(output).toBeTruthy();
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", output!,
  ], { encoding: "utf8" }));
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  expect(video?.width).toBe(3840);
  expect(video?.height).toBe(2160);
  expect(Number(probe.format?.duration || 0)).toBeGreaterThan(rangeEnd - rangeStart - 0.5);
  expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
});
