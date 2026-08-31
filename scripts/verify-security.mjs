import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const roots = ["app", "components", "hooks", "lib", "worker"];
const extensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (extensions.has(extname(path))) files.push(path);
  }
}
for (const directory of roots) walk(join(root, directory));
for (const path of files) {
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /\beval\s*\(/, `eval() is forbidden in ${relative(root, path)}`);
  assert.doesNotMatch(source, /new\s+Function\s*\(/, `new Function() is forbidden in ${relative(root, path)}`);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `dangerouslySetInnerHTML requires removal/review in ${relative(root, path)}`);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, `Direct innerHTML assignment is forbidden in ${relative(root, path)}`);
  assert.doesNotMatch(source, /(?:fetch|import|new\s+Worker)\(\s*["'\x60]https?:\/\//i, `Remote runtime/model execution is forbidden in ${relative(root, path)}`);
}
const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
assert.match(layout, /Content-Security-Policy/);
assert.match(layout, /object-src 'none'/);
assert.match(layout, /connect-src 'self' blob:/);
console.log(`Security source audit passed: ${files.length} source files, CSP present.`);
