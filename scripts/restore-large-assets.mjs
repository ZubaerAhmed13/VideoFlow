import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "large-assets", "manifest.json");
const optional = process.argv.includes("--if-present");

function sha256(path) {
  const hash = createHash("sha256");
  return new Promise((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function validTarget(asset) {
  const target = join(root, asset.target);
  return (
    existsSync(target) &&
    statSync(target).size === asset.sizeBytes &&
    (await sha256(target)) === asset.sha256
  );
}

if (!existsSync(manifestPath)) {
  if (optional) {
    console.log("[assets] no split-asset manifest; existing release assets are unchanged");
    process.exit(0);
  }
  throw new Error(`Missing split-asset manifest: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
  throw new Error("Unsupported split-asset manifest");
}

for (const asset of manifest.assets) {
  if (await validTarget(asset)) {
    console.log(`[assets] verified ${asset.target}`);
    continue;
  }

  const target = join(root, asset.target);
  const temporary = `${target}.reconstructing`;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(temporary, { force: true });
  const output = createWriteStream(temporary, { flags: "wx" });

  try {
    for (const part of asset.parts) {
      const partPath = join(root, part.path);
      if (!existsSync(partPath) || statSync(partPath).size !== part.sizeBytes) {
        throw new Error(`Missing or incomplete asset part: ${part.path}`);
      }
      if ((await sha256(partPath)) !== part.sha256) {
        throw new Error(`Asset part checksum mismatch: ${part.path}`);
      }
      await pipeline(createReadStream(partPath), output, { end: false });
    }
    output.end();
    await new Promise((resolveWrite, reject) => {
      output.on("finish", resolveWrite);
      output.on("error", reject);
    });
    if (statSync(temporary).size !== asset.sizeBytes || (await sha256(temporary)) !== asset.sha256) {
      throw new Error(`Reconstructed asset integrity failure: ${asset.target}`);
    }
    rmSync(target, { force: true });
    renameSync(temporary, target);
    console.log(`[assets] restored and verified ${asset.target}`);
  } catch (error) {
    output.destroy();
    rmSync(temporary, { force: true });
    throw error;
  }
}

console.log("[assets] all checksum-pinned release assets are ready");
