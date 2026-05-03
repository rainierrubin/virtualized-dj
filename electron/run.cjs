/**
 * Convenience launcher for `npm run electron:start`. Builds (if needed) and
 * runs Electron pointing at the standalone server.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone", "server.js");

if (!fs.existsSync(standalone)) {
  console.log("[generative-dj] no standalone build — running `next build`...");
  const r = spawnSync("npx", ["next", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Copy public/ + .next/static into standalone so the server serves them.
const standaloneDir = path.join(root, ".next", "standalone");
const staticSrc = path.join(root, ".next", "static");
const staticDst = path.join(standaloneDir, ".next", "static");
const publicSrc = path.join(root, "public");
const publicDst = path.join(standaloneDir, "public");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (fs.existsSync(staticSrc)) copyDir(staticSrc, staticDst);
if (fs.existsSync(publicSrc)) copyDir(publicSrc, publicDst);

const r = spawnSync("npx", ["electron", path.join(root, "electron", "main.cjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 0);
