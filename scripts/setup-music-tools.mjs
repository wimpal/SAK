// Download yt-dlp and Deno sidecars into src-tauri/binaries (Windows x64).
//
// Usage (from repo root):
//   node scripts/setup-music-tools.mjs
//
// Options:
//   --from-ytdlp "C:\path\yt-dlp.exe"
//   --from-deno "C:\path\deno.exe"

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const targetDir = resolve(repoRoot, "src-tauri/binaries");
const TARGET = "x86_64-pc-windows-msvc";

const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const DENO_ZIP_URL =
  "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";

function parseArgs(argv) {
  const args = { fromYtdlp: null, fromDeno: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--from-ytdlp") args.fromYtdlp = argv[++i] ?? null;
    else if (token === "--from-deno") args.fromDeno = argv[++i] ?? null;
  }
  return args;
}

function sidecarName(base) {
  if (process.platform === "win32") {
    return `${base}-${TARGET}.exe`;
  }
  if (process.platform === "darwin") {
    return `${base}-x86_64-apple-darwin`;
  }
  return `${base}-x86_64-unknown-linux-gnu`;
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}…`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function downloadYtdlp(dest) {
  const temp = `${dest}.download`;
  await downloadFile(YTDLP_URL, temp);
  rmSync(dest, { force: true });
  renameSync(temp, dest);
}

async function downloadDeno(dest) {
  if (process.platform !== "win32") {
    throw new Error("Automatic Deno download is only supported on Windows.");
  }

  const zipPath = join(targetDir, "deno.zip");
  const extractDir = join(targetDir, "_deno_extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  await downloadFile(DENO_ZIP_URL, zipPath);

  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to extract Deno zip (exit ${result.status ?? "unknown"})`);
  }

  const extracted = join(extractDir, "deno.exe");
  if (!existsSync(extracted)) {
    throw new Error(`deno.exe not found after extracting ${zipPath}`);
  }

  rmSync(dest, { force: true });
  cpSync(extracted, dest);
  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

async function ensureSidecar(base, downloadFn, fromPath) {
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, sidecarName(base));

  if (fromPath) {
    const resolved = resolve(fromPath);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    console.log(`Copying ${base} from ${resolved}…`);
    cpSync(resolved, dest);
    return dest;
  }

  if (existsSync(dest)) {
    console.log(`${sidecarName(base)} already present`);
    return dest;
  }

  await downloadFn(dest);
  console.log(`Installed ${dest}`);
  return dest;
}

async function main() {
  if (process.platform !== "win32") {
    console.warn(
      "This script targets Windows sidecar names. Copy yt-dlp and deno manually into src-tauri/binaries.",
    );
  }

  const args = parseArgs(process.argv.slice(2));
  await ensureSidecar("yt-dlp", downloadYtdlp, args.fromYtdlp);
  await ensureSidecar("deno", downloadDeno, args.fromDeno);
  console.log(`Music sidecars ready in ${targetDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
