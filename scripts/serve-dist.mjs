import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 4173);
const distRoot = join(process.cwd(), "dist");
const root = existsSync(join(distRoot, "client", "index.html"))
  ? join(distRoot, "client")
  : distRoot;
if (!existsSync(join(root, "index.html"))) {
  throw new Error("Static dist/index.html is missing. Run the verified build first.");
}
const mime = {
  ".css": "text/css; charset=utf-8",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname).replace(/^\/VideoFlow\/?/, "/");
  let target = normalize(join(root, pathname));
  if (!target.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (!existsSync(target)) target = join(root, "index.html");
  response.writeHead(200, {
    "Content-Type": mime[extname(target)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "Service-Worker-Allowed": "/VideoFlow/",
  });
  createReadStream(target).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`VideoFlow test server: http://127.0.0.1:${port}/VideoFlow/`);
});
