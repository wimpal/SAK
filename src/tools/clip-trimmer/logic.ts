export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "wmv",
];

export const MIN_SELECTION_SECS = 0.1;
export const DEFAULT_FPS = 30;

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : path;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function fileStem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileExtension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "mp4";
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${file}`;
}

export function isVideoPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.includes(name.slice(dot + 1));
}

export function defaultOutputName(sourcePath: string): string {
  return `${fileStem(sourcePath)}-trimmed`;
}

export function sanitizeOutputName(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) {
      stem = stem.slice(0, -(ext.length + 1));
      break;
    }
  }
  return stem.trim() || "trimmed";
}

export function isValidOutputName(name: string): boolean {
  return sanitizeOutputName(name).length > 0;
}

export function outputPath(
  sourcePath: string,
  outputDir: string | null,
  outputName?: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  const stem = sanitizeOutputName(outputName ?? defaultOutputName(sourcePath));
  const ext = fileExtension(sourcePath);
  return joinPath(dir, `${stem}.${ext}`);
}

export function clampTime(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function nudgeTime(
  value: number,
  delta: number,
  min: number,
  max: number,
): number {
  return clampTime(value + delta, min, max);
}

export function frameStep(fps: number): number {
  return fps > 0 ? 1 / fps : 1 / DEFAULT_FPS;
}

/**
 * After a successful trim, find the next free output stem:
 * `video-trimmed` → `video-trimmed-2` → `video-trimmed-3` …
 */
export async function nextAvailableOutputStemAfter(
  sourcePath: string,
  outputDir: string | null,
  currentStem: string,
  pathsExistFn: (paths: string[]) => Promise<boolean[]>,
): Promise<string> {
  const sanitized = sanitizeOutputName(currentStem);
  const numbered = sanitized.match(/^(.*)-(\d+)$/);
  const prefix = numbered ? numbered[1] : sanitized;
  const startN = numbered ? Number(numbered[2]) + 1 : 2;

  for (let n = startN; n < 10000; n++) {
    const candidate = `${prefix}-${n}`;
    const path = outputPath(sourcePath, outputDir, candidate);
    const exists = await pathsExistFn([path]);
    if (!exists[0]) return candidate;
  }

  return `${prefix}-${startN}`;
}

export function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const totalMs = Math.round(secs * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = Math.floor((totalMs % 1000) / 100);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
  }
  return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

export function formatDuration(secs: number): string {
  return formatTime(secs);
}

export type SessionAction = "trimmed" | "deleted" | "failed";

export interface SessionResult {
  path: string;
  action: SessionAction;
  detail?: string;
  outputPath?: string;
}

/** Upsert a result for a path (latest action wins). */
export function upsertSessionResult(
  results: SessionResult[],
  next: SessionResult,
): SessionResult[] {
  return [...results.filter((r) => r.path !== next.path), next];
}

export function summarizeSession(
  results: SessionResult[],
  remaining: number,
): string {
  const trimmed = results.filter((r) => r.action === "trimmed").length;
  const deleted = results.filter((r) => r.action === "deleted").length;
  const failed = results.filter((r) => r.action === "failed").length;
  const parts: string[] = [];
  if (trimmed > 0) parts.push(`${trimmed} trimmed`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (remaining > 0) parts.push(`${remaining} remaining`);
  if (parts.length === 0) return "No clips processed.";
  return parts.join(", ") + ".";
}
