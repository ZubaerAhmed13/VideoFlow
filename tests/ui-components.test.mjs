import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let React;
let renderToStaticMarkup;
let createServer;
let dependencyError = null;
try {
  React = (await import("react")).default;
  ({ renderToStaticMarkup } = await import("react-dom/server"));
  ({ createServer } = await import("vite"));
} catch (error) {
  dependencyError = error;
}

async function readCssTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readCssTree(entryPath);
    return entry.name.endsWith(".css") ? readFile(entryPath, "utf8") : "";
  }));
  return contents.join("\n");
}

test("emits the catalog's animation and scrolling utilities", async () => {
  const css = await readCssTree(path.join(root, "dist"));
  assert.match(css, /--tw-enter-opacity/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /scroll-fade-reveal-b/);
  assert.match(css, /mask-image:/);
  assert.match(css, /tw-shimmer/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

const uiTest = (name, fn) => test(name, { skip: dependencyError ? `React/Vite dependencies unavailable in this execution environment: ${dependencyError.code ?? dependencyError}` : false }, fn);

uiTest("forwards progress semantics to the primitive", async () => {
  const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
  try {
    const { Progress } = await vite.ssrLoadModule("/components/ui/progress.tsx");
    const html = renderToStaticMarkup(React.createElement(Progress, { value: 37 }));
    assert.match(html, /aria-valuenow="37"/);
    assert.match(html, /aria-valuetext="37%"/);
    assert.match(html, /data-state="loading"/);
  } finally { await vite.close(); }
});

uiTest("emits chart themes for the starter's media dark mode", async () => {
  const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
  try {
    const { ChartStyle } = await vite.ssrLoadModule("/components/ui/chart.tsx");
    const html = renderToStaticMarkup(React.createElement(ChartStyle, { id: "contract", config: { latency: { theme: { light: "#ffffff", dark: "#000000" } } } }));
    assert.match(html, /\[data-chart=contract\]/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(html, /\.dark/);
  } finally { await vite.close(); }
});

uiTest("renders sidebar skeletons deterministically", async () => {
  const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
  try {
    const { SidebarMenuSkeleton } = await vite.ssrLoadModule("/components/ui/sidebar.tsx");
    const first = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
    const second = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
    assert.equal(first, second);
    assert.match(first, /--skeleton-width:70%/);
  } finally { await vite.close(); }
});
