import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, statSync, truncateSync, writeSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const generated = join(root, "tests", "fixtures", "generated");
const outputs = join(root, "outputs", "certification");
mkdirSync(generated, { recursive: true });
mkdirSync(outputs, { recursive: true });

const uhd = join(generated, "uhd-4k-5s.mp4");
if (!existsSync(uhd)) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=24:d=5",
    "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=5",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", uhd,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "ffmpeg failed generating 4K fixture");
}

const sparse = join(outputs, "large-3gb-4k-sparse.mp4");
copyFileSync(uhd, sparse);
// An MP4 size=0 `free` atom legally extends to EOF. Truncating after this header creates
// a sparse 3 GiB logical file while preserving a small, real, decodable 4K media payload.
const fd = openSync(sparse, "a");
writeSync(fd, Buffer.from([0, 0, 0, 0, 0x66, 0x72, 0x65, 0x65]));
closeSync(fd);
truncateSync(sparse, 3 * 1024 ** 3);

let probe = "ffprobe unavailable";
try {
  probe = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate:format=duration,size",
    "-of", "default=noprint_wrappers=1", sparse,
  ], { encoding: "utf8" }).trim();
} catch {}

console.log(JSON.stringify({
  uhd,
  uhdBytes: statSync(uhd).size,
  sparse,
  sparseLogicalBytes: statSync(sparse).size,
  ffprobe: probe,
}, null, 2));
