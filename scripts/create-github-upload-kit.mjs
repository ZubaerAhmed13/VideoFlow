import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const product = "VideoFlow_Professional_Core_1.0.0_GitHub_Upload";
const output = resolve(root, "..", "github-upload-kit");
const stage = join(tmpdir(), `${product}_stage`);
const destination = join(stage, product);
const chunkSize = 20 * 1024 * 1024;
const githubWebLimit = 25 * 1024 * 1024;

const assetDefinitions = [
  { target: "public/models/lama-512-int8.onnx" },
  { target: "public/vendor/ffmpeg/ffmpeg-core.wasm" },
  { target: "public/vendor/onnx/ort-wasm-simd-threaded.jsep.wasm" },
];
const omittedTargets = new Set(assetDefinitions.map(({ target }) => target));
const excludedTopLevel = new Set([
  ".git",
  ".next",
  ".pages-dist",
  ".sites-runtime",
  ".tmp-ai-pack",
  ".wrangler",
  "dist",
  "node_modules",
  "outputs",
  "playwright-report",
  "test-results",
  "tsconfig.tsbuildinfo",
  "work",
  "github-upload-kit",
  "VideoFlow_Professional_Core_1.0.0_Final_Release.zip",
]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function posix(path) {
  return path.split(sep).join("/");
}

function makeSplitAssets() {
  const splitRoot = join(root, "large-assets");
  rmSync(splitRoot, { recursive: true, force: true });
  mkdirSync(splitRoot, { recursive: true });
  const assets = [];

  for (const definition of assetDefinitions) {
    const source = join(root, definition.target);
    if (!existsSync(source)) throw new Error(`Required release asset is missing: ${definition.target}`);
    const bytes = readFileSync(source);
    const assetName = basename(definition.target);
    const assetFolder = join(splitRoot, assetName);
    mkdirSync(assetFolder, { recursive: true });
    const parts = [];
    for (let offset = 0, index = 1; offset < bytes.length; offset += chunkSize, index += 1) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      const partName = `${assetName}.part-${String(index).padStart(3, "0")}`;
      const partPath = join(assetFolder, partName);
      writeFileSync(partPath, chunk);
      parts.push({
        path: posix(relative(root, partPath)),
        sizeBytes: chunk.byteLength,
        sha256: sha256Bytes(chunk),
      });
    }
    assets.push({
      target: definition.target,
      sizeBytes: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      parts,
    });
  }

  writeFileSync(
    join(splitRoot, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, chunkSizeBytes: chunkSize, assets }, null, 2)}\n`,
  );
}

function copyRepository() {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (excludedTopLevel.has(entry)) continue;
    const source = join(root, entry);
    const target = join(destination, entry);
    cpSync(source, target, {
      recursive: true,
      filter(path) {
        const relativePath = posix(relative(root, path));
        if (omittedTargets.has(relativePath)) return false;
        if (relativePath === "tests/fixtures/generated" || relativePath.startsWith("tests/fixtures/generated/")) return false;
        return !(
          basename(path) === "__MACOSX" ||
          basename(path) === ".DS_Store" ||
          basename(path).startsWith("._") ||
          /\.(?:orig|bak)$/i.test(basename(path))
        );
      },
    });
  }
}

function writeInstructions() {
  const instructions = `# VideoFlow GitHub upload and verification\n\nThis repository edition contains the complete VideoFlow source. The three runtime/model files that exceed GitHub's 25 MB web-upload limit are stored as checksum-pinned parts under \`large-assets/\`. GitHub Actions reconstructs and validates them before installing or testing anything.\n\n## Merge the download parts\n\nExtract every \`VideoFlow_GitHub_Upload_Part_*.zip\` into the same parent folder. Each ZIP contains the same top-level folder and the files merge without conflicts.\n\n## Upload\n\n1. Open the merged \`${product}\` folder.\n2. Create an empty GitHub repository with Actions enabled.\n3. Upload the folder contents (not the outer folder) to the repository's \`main\` branch. Every individual file is below 25 MB. Upload in folder-sized batches if the browser limits the number of files per batch.\n4. In **Actions**, run **VideoFlow AI release verification** if the push did not start it automatically.\n5. Do not treat the Pages deployment as certified unless the full release-verification workflow is green.\n\n## What GitHub verifies\n\nThe workflow reconstructs the local LaMa/FFmpeg/ONNX assets, checks SHA-256 integrity, performs a clean \`npm ci\`, builds a fresh production distribution, and runs the static, security, unit, media-quality, colour, AI/WASM, Chromium, Firefox, WebKit, offline/PWA, nested-path, sparse 3 GiB, and 4K gates. The final release ZIP and evidence are uploaded as workflow artifacts only after the required gates pass.\n\n## Return evidence\n\nSend the workflow run URL or download and return the \`certification-evidence\` artifact. If a test fails, preserve the full log so the failure can be classified and fixed rather than marked as passed.\n`;
  writeFileSync(join(destination, "GITHUB_UPLOAD_INSTRUCTIONS.md"), instructions);
  writeFileSync(join(output, "GITHUB_UPLOAD_INSTRUCTIONS.md"), instructions);
}

function collectFiles(directory) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) visit(item);
      else files.push(item);
    }
  };
  visit(directory);
  return files.sort();
}

function createParts() {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeInstructions();
  const files = collectFiles(destination);
  for (const file of files) {
    if (statSync(file).size >= githubWebLimit) {
      throw new Error(`GitHub upload file exceeds 25 MiB: ${relative(destination, file)}`);
    }
  }

  const groups = [];
  let group = [];
  let bytes = 0;
  const rawGroupLimit = 18 * 1024 * 1024;
  for (const file of files) {
    const size = statSync(file).size;
    if (group.length && bytes + size > rawGroupLimit) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(file);
    bytes += size;
  }
  if (group.length) groups.push(group);

  const archives = [];
  groups.forEach((fileGroup, index) => {
    const archive = join(output, `VideoFlow_GitHub_Upload_Part_${String(index + 1).padStart(2, "0")}.zip`);
    const args = ["-q", archive, ...fileGroup.map((file) => posix(relative(stage, file)))];
    const result = spawnSync("zip", args, { cwd: stage, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `Could not create ${archive}`);
    if (statSync(archive).size >= githubWebLimit) throw new Error(`Upload part exceeds 25 MiB: ${archive}`);
    archives.push(archive);
  });

  const checksums = archives
    .map((archive) => `${sha256File(archive)}  ${basename(archive)}`)
    .join("\n");
  writeFileSync(join(output, "SHA256SUMS.txt"), `${checksums}\n`);
  return archives;
}

mkdirSync(output, { recursive: true });
makeSplitAssets();
copyRepository();
const archives = createParts();
console.log(JSON.stringify({ output, product, parts: archives.length }, null, 2));
