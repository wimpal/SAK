// Download or link the portable Calibre runtime into src-tauri/resources/calibre.
//
// Usage (from repo root):
//   node scripts/setup-calibre.mjs
//
// Options:
//   --from "C:\Program Files\Calibre2"   copy from an existing install
//   --version 7.24.0                     Calibre version to download (default: latest known)

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const targetDir = resolve(repoRoot, "src-tauri/resources/calibre");
const DEFAULT_VERSION = "7.24.0";

function parseArgs(argv) {
  const args = { from: null, version: DEFAULT_VERSION };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--from") {
      args.from = argv[++i] ?? null;
    } else if (token === "--version") {
      args.version = argv[++i] ?? DEFAULT_VERSION;
    }
  }
  return args;
}

function exeName() {
  return process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert";
}

function hasCalibreRuntime(dir) {
  return existsSync(join(dir, exeName()));
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

function copyFromInstall(sourceDir) {
  const resolved = resolve(sourceDir);
  if (!hasCalibreRuntime(resolved)) {
    throw new Error(`No ${exeName()} found in ${resolved}`);
  }
  console.log(`Copying Calibre runtime from ${resolved}…`);
  copyTree(resolved, targetDir);
}

async function downloadPortable(version) {
  const fileName = `calibre-portable-installer-${version}.exe`;
  const url = `https://download.calibre-ebook.com/${version}/${fileName}`;
  const installerPath = join(targetDir, fileName);

  mkdirSync(targetDir, { recursive: true });
  console.log(`Downloading ${url}…`);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed (${response.status}). Try --from "C:\\Program Files\\Calibre2" or install Calibre manually into ${targetDir}`,
    );
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(installerPath));
  console.log(`Downloaded ${installerPath}`);

  if (process.platform !== "win32") {
    throw new Error(
      "Automatic Calibre download is only supported on Windows. Copy a portable Calibre tree into src-tauri/resources/calibre manually.",
    );
  }

  const staging = join(targetDir, "_staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Calibre's portable installer requires a destination path argument.
  // See https://calibre-ebook.com/download_portable (Automated install).
  console.log(`Extracting portable Calibre to ${staging}…`);
  const result = spawnSync(installerPath, [staging], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Portable installer exited with code ${result.status ?? "unknown"}. ` +
        `If extraction was blocked by antivirus, allow the installer or run: ` +
        `node scripts/setup-calibre.mjs --from "C:\\Program Files\\Calibre2"`,
    );
  }

  if (!findCalibreRoot(staging)) {
    throw new Error(
      `Installer finished but ${exeName()} was not found under ${staging}. ` +
        `Copy a Calibre install into ${targetDir} or use --from.`,
    );
  }

  for (const entry of readdirSync(staging)) {
    const from = join(staging, entry);
    const to = join(targetDir, entry);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }

  rmSync(staging, { recursive: true, force: true });
  rmSync(installerPath, { force: true });
}

function findCalibreRoot(root) {
  if (hasCalibreRuntime(root)) return root;

  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(current, entry.name);
      if (hasCalibreRuntime(child)) return child;
      queue.push(child);
    }
  }
  return null;
}

function writeVersionStamp(version) {
  writeFileSync(join(targetDir, "SAK_CALIBRE_VERSION.txt"), `${version}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.from) {
    copyFromInstall(args.from);
    writeVersionStamp("installed-copy");
    console.log(`Calibre runtime ready at ${targetDir}`);
    return;
  }

  if (hasCalibreRuntime(targetDir)) {
    console.log(`Calibre runtime already present at ${targetDir}`);
    return;
  }

  await downloadPortable(args.version);
  writeVersionStamp(args.version);
  console.log(`Calibre runtime ready at ${targetDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
