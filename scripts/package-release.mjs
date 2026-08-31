import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const name = "VideoFlow_Professional_Core_1.0.0";
const archive = join(root, `${name}_Final_Release.zip`);
const staging = join(tmpdir(), `${name}_release_stage`);
const destination = join(staging, name);
const excluded = new Set([
  ".git",
  ".next",
  ".sites-runtime",
  ".wrangler",
  "dist",
  "node_modules",
  "outputs",
  "playwright-report",
  "test-results",
  ".tmp-ai-pack",
  "maintenance",
  "GITHUB_UPLOAD_NOTE.md",
  "GITHUB_UPLOAD_INSTRUCTIONS.md",
  "large-assets",
  "PROJECT_FILE_MANIFEST.txt",
  "PROJECT_FILE_MANIFEST_GITHUB.txt",
  "REMAINING_WORK_SPEC.md",
  "tsconfig.tsbuildinfo",
  "work",
  basename(archive),
]);


function runGate(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) {
    throw new Error(`${label} failed.\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

runGate(process.execPath, ["scripts/verify-release.mjs"], "Static release verification", {
  env: { ...process.env, VIDEOFLOW_REQUIRE_AI_PACK: "1" },
});
runGate(process.execPath, ["scripts/verify-nested-http.mjs"], "Nested-path verification");
runGate("bash", ["-lc", "node --test tests/*.test.mjs"], "Portable test suite");
runGate(process.execPath, ["scripts/certify-media-quality.mjs"], "Media quality certification");
const staticDist = existsSync(join(root, "dist", "client", "index.html"))
  ? join(root, "dist", "client")
  : join(root, "dist");
if (!existsSync(join(staticDist, "index.html")))
  throw new Error("Verified static output is missing. Build before packaging.");
rmSync(staging, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const entry of readdirSync(root)) {
  if (excluded.has(entry)) continue;
  cpSync(join(root, entry), join(destination, entry), { recursive: true });
}
cpSync(staticDist, join(destination, "dist"), {
  recursive: true,
});
rmSync(join(destination, "dist", ".vite"), { recursive: true, force: true });
const removeJunk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "__MACOSX" || entry.name === ".DS_Store" || /\.(?:orig|bak)$/i.test(entry.name) || entry.name.startsWith("._")) {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) removeJunk(path);
  }
};
removeJunk(destination);
rmSync(join(destination, "tests", "fixtures", "generated"), { recursive: true, force: true });
rmSync(archive, { force: true });
const result = spawnSync("zip", ["-q", "-r", archive, name], {
  cwd: staging,
  encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || "zip failed");
console.log(archive);
