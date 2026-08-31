import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), "..");
const roots = ["app", "components", "hooks", "lib", "scripts", "worker", "workers", ".github"];
const singleFiles = ["package.json", "package-lock.json", "vite.config.ts", "playwright.config.ts", "tsconfig.json"];

function collect(directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collect(path, output);
    else if (!path.endsWith("generate-build-info.mjs") && !path.endsWith("build-info.json")) output.push(path);
  }
}

export function computeSourceFingerprint() {
  const files = [];
  for (const directory of roots) collect(join(root, directory), files);
  for (const file of singleFiles) if (existsSync(join(root, file))) files.push(join(root, file));
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildInfo() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const sourceHash = computeSourceFingerprint();
  return {
    product: "VideoFlow Professional Core",
    version: pkg.version,
    build: `${pkg.version}-${sourceHash.slice(0, 12)}`,
    sourceHash,
    builtAt: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now())).toISOString(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const info = buildInfo();
  writeFileSync(join(root, "public", "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`Build fingerprint: ${info.build}`);
}
