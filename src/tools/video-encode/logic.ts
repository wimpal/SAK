export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "wmv",
  "ts",
];

export const TARGET_CONTAINERS = [
  "mp4",
  "mkv",
  "mov",
  "webm",
  "ts",
  "m4v",
] as const;
export type TargetContainer = (typeof TARGET_CONTAINERS)[number];

export const VIDEO_CODECS = ["h264", "h265", "vp9", "av1"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export const PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;
export type EncodePreset = (typeof PRESETS)[number];

export const RESOLUTION_OPTIONS = [
  { id: "original", label: "Original", height: null },
  { id: "1080", label: "1080p", height: 1080 },
  { id: "720", label: "720p", height: 720 },
  { id: "480", label: "480p", height: 480 },
] as const;
export type ResolutionId = (typeof RESOLUTION_OPTIONS)[number]["id"];

export const DEFAULT_NAME_PATTERN = "{stem}-encoded";

export interface MediaStreamInfo {
  index: number;
  codecType: string;
  codecName: string;
  width?: number;
  height?: number;
  language?: string;
  title?: string;
}

export interface MediaStreamsProbe {
  durationSecs: number;
  streams: MediaStreamInfo[];
}

export type PreviewStatus =
  | "ready"
  | "same_file"
  | "unsupported"
  | "exists"
  | "duplicate"
  | "warn"
  | "incompatible";

export type ResultStatus =
  | PreviewStatus
  | "encoding"
  | "ok"
  | "failed"
  | "cancelled"
  | "skipped";

export interface PreviewRow {
  from: string;
  to: string;
  status: PreviewStatus;
  bumped?: boolean;
  warnReason?: string;
}

export interface RowResult {
  status: ResultStatus;
  error?: string;
}

const MP4_FAMILY_INCOMPATIBLE_AUDIO = [
  "dts",
  "truehd",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "flac",
];

const CODEC_CONTAINERS: Record<VideoCodec, readonly TargetContainer[]> = {
  h264: ["mp4", "mkv", "mov", "m4v", "ts"],
  h265: ["mp4", "mkv", "mov", "m4v"],
  vp9: ["webm", "mkv"],
  av1: ["mp4", "mkv", "webm"],
};

const DEFAULT_CRF: Record<VideoCodec, number> = {
  h264: 23,
  h265: 28,
  vp9: 30,
  av1: 28,
};

const CRF_RANGE: Record<VideoCodec, { min: number; max: number }> = {
  h264: { min: 0, max: 51 },
  h265: { min: 0, max: 51 },
  vp9: { min: 0, max: 63 },
  av1: { min: 0, max: 63 },
};

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

export function fileExtension(path: string): string | null {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return name.slice(dot + 1);
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${file}`;
}

export function isVideoPath(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== null && VIDEO_EXTENSIONS.includes(ext);
}

export function isTargetContainer(value: string): value is TargetContainer {
  return (TARGET_CONTAINERS as readonly string[]).includes(value);
}

export function isVideoCodec(value: string): value is VideoCodec {
  return (VIDEO_CODECS as readonly string[]).includes(value);
}

export function isEncodePreset(value: string): value is EncodePreset {
  return (PRESETS as readonly string[]).includes(value);
}

export function isResolutionId(value: string): value is ResolutionId {
  return RESOLUTION_OPTIONS.some((option) => option.id === value);
}

export function containersForCodec(codec: VideoCodec): readonly TargetContainer[] {
  return CODEC_CONTAINERS[codec];
}

export function defaultContainerForCodec(codec: VideoCodec): TargetContainer {
  const allowed = containersForCodec(codec);
  if (allowed.includes("mp4")) return "mp4";
  if (allowed.includes("webm")) return "webm";
  return allowed[0];
}

export function codecAllowsContainer(
  codec: VideoCodec,
  container: TargetContainer,
): boolean {
  return containersForCodec(codec).includes(container);
}

export function defaultCrf(codec: VideoCodec): number {
  return DEFAULT_CRF[codec];
}

export function crfRange(codec: VideoCodec): { min: number; max: number } {
  return CRF_RANGE[codec];
}

export function clampCrf(codec: VideoCodec, value: number): number {
  const { min, max } = crfRange(codec);
  if (Number.isNaN(value)) return defaultCrf(codec);
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function scaleHeightForResolution(
  resolution: ResolutionId,
): number | null {
  const option = RESOLUTION_OPTIONS.find((item) => item.id === resolution);
  return option?.height ?? null;
}

export function sourceVideoSize(
  streams: MediaStreamInfo[],
): { width: number; height: number } | null {
  const video = streams.find(
    (stream) =>
      stream.codecType.toLowerCase() === "video" &&
      typeof stream.width === "number" &&
      typeof stream.height === "number" &&
      stream.width > 0 &&
      stream.height > 0,
  );
  if (!video || video.width == null || video.height == null) return null;
  return { width: video.width, height: video.height };
}

export function sanitizeOutputStem(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  for (const ext of [...VIDEO_EXTENSIONS, ...TARGET_CONTAINERS]) {
    if (lower.endsWith(`.${ext}`)) {
      stem = stem.slice(0, -(ext.length + 1));
      break;
    }
  }
  return stem.trim();
}

export function applyNamePattern(
  pattern: string,
  stem: string,
  index1Based: number,
): string {
  const trimmed = pattern.trim();
  const source = trimmed.length > 0 ? trimmed : DEFAULT_NAME_PATTERN;
  const applied = source
    .replace(/\{stem\}/g, stem)
    .replace(/\{n\}/g, String(index1Based));
  const sanitized = sanitizeOutputStem(applied);
  if (sanitized.length > 0) {
    return sanitized;
  }
  return sanitizeOutputStem(
    DEFAULT_NAME_PATTERN
      .replace("{stem}", stem)
      .replace("{n}", String(index1Based)),
  );
}

export function isValidNamePattern(pattern: string): boolean {
  return applyNamePattern(pattern, "clip", 1).length > 0;
}

export function defaultOutputStem(sourcePath: string): string {
  return applyNamePattern(DEFAULT_NAME_PATTERN, fileStem(sourcePath), 1);
}

export function outputPath(
  sourcePath: string,
  outputDir: string | null,
  targetContainer: TargetContainer,
  outputStem?: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  const stem = outputStem ?? defaultOutputStem(sourcePath);
  return joinPath(dir, `${stem}.${targetContainer}`);
}

function samePathIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function audioNeedsReencode(
  streams: MediaStreamInfo[],
  container: TargetContainer,
): boolean {
  const audioStreams = streams.filter(
    (stream) => stream.codecType.toLowerCase() === "audio",
  );
  if (audioStreams.length === 0) return false;

  for (const stream of audioStreams) {
    const codec = stream.codecName.toLowerCase();
    if (container === "webm") {
      if (codec !== "opus" && codec !== "vorbis") return true;
      continue;
    }
    if (
      container === "mp4" ||
      container === "mov" ||
      container === "m4v"
    ) {
      if (MP4_FAMILY_INCOMPATIBLE_AUDIO.includes(codec)) return true;
    }
  }
  return false;
}

export type AudioMode = "copy" | "aac" | "opus";

export function audioModeForEncode(
  streams: MediaStreamInfo[],
  container: TargetContainer,
): AudioMode {
  if (audioNeedsReencode(streams, container)) {
    return container === "webm" ? "opus" : "aac";
  }
  return "copy";
}

export function audioModeLabel(mode: AudioMode): string {
  switch (mode) {
    case "copy":
      return "copy audio";
    case "aac":
      return "re-encode audio to AAC";
    case "opus":
      return "re-encode audio to Opus";
  }
}

export function resolveStemAvoidingCollision(
  initialStem: string,
  sourcePath: string,
  outputDir: string | null,
  targetContainer: TargetContainer,
  existsMap: Map<string, boolean>,
): { stem: string; bumped: boolean } {
  const base = initialStem.match(/^(.*)-(\d+)$/)?.[1] ?? initialStem;
  let candidate = initialStem;
  let bumped = false;
  let n = 2;

  for (let guard = 0; guard < 10000; guard++) {
    const to = outputPath(sourcePath, outputDir, targetContainer, candidate);
    if (existsMap.get(to) !== true) {
      return { stem: candidate, bumped };
    }
    candidate = `${base}-${n}`;
    bumped = true;
    n += 1;
  }

  return { stem: initialStem, bumped };
}

export function buildPreview(
  paths: string[],
  targetContainer: TargetContainer,
  outputDir: string | null,
  existsMap: Map<string, boolean>,
  namePattern: string,
  videoCodec: VideoCodec,
  streamsByPath: Map<string, MediaStreamInfo[]>,
): PreviewRow[] {
  const seenTargets = new Set<string>();
  const rows: PreviewRow[] = [];

  if (!codecAllowsContainer(videoCodec, targetContainer)) {
    return paths.map((from) => ({
      from,
      to: from,
      status: "incompatible" as const,
      warnReason: `${videoCodec.toUpperCase()} is not valid in .${targetContainer}`,
    }));
  }

  for (let i = 0; i < paths.length; i++) {
    const from = paths[i];
    if (!isVideoPath(from)) {
      rows.push({ from, to: from, status: "unsupported" });
      continue;
    }

    const streams = streamsByPath.get(from) ?? [];
    const initialStem = applyNamePattern(namePattern, fileStem(from), i + 1);
    const { stem, bumped } = resolveStemAvoidingCollision(
      initialStem,
      from,
      outputDir,
      targetContainer,
      existsMap,
    );
    const to = outputPath(from, outputDir, targetContainer, stem);
    const toKey = to.toLowerCase();

    if (samePathIgnoreCase(from, to)) {
      rows.push({ from, to, status: "same_file", bumped });
      continue;
    }

    if (existsMap.get(to) === true) {
      rows.push({ from, to, status: "exists", bumped });
      continue;
    }

    if (seenTargets.has(toKey)) {
      rows.push({ from, to, status: "duplicate", bumped });
      continue;
    }

    seenTargets.add(toKey);

    const hasVideo = streams.some(
      (stream) => stream.codecType.toLowerCase() === "video",
    );
    if (streams.length > 0 && !hasVideo) {
      rows.push({
        from,
        to,
        status: "incompatible",
        bumped,
        warnReason: "No video stream",
      });
      continue;
    }

    const mode = audioModeForEncode(streams, targetContainer);
    if (mode !== "copy") {
      rows.push({
        from,
        to,
        status: "warn",
        bumped,
        warnReason: audioModeLabel(mode),
      });
      continue;
    }

    rows.push({ from, to, status: "ready", bumped });
  }

  return rows;
}

export function isRunnable(status: PreviewStatus): boolean {
  return status === "ready" || status === "warn";
}

export function statusLabel(
  status: PreviewStatus | ResultStatus,
  bumped?: boolean,
): string {
  switch (status) {
    case "ready":
      return bumped ? "Ready (renamed)" : "Ready";
    case "warn":
      return bumped ? "Will re-encode audio (renamed)" : "Will re-encode audio";
    case "same_file":
      return "Same as source";
    case "unsupported":
      return "Unsupported";
    case "exists":
      return "Already exists";
    case "duplicate":
      return "Duplicate in batch";
    case "incompatible":
      return "Incompatible";
    case "encoding":
      return "Encoding";
    case "ok":
      return "OK";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
}

export function statusClass(status: PreviewStatus | ResultStatus): string {
  switch (status) {
    case "ready":
    case "ok":
      return "text-zinc-400";
    case "warn":
    case "encoding":
      return "text-zinc-300";
    case "same_file":
    case "skipped":
    case "cancelled":
      return "text-zinc-600";
    case "unsupported":
    case "exists":
    case "duplicate":
    case "incompatible":
    case "failed":
      return "text-brand-soft";
  }
}

export function codecLabel(codec: VideoCodec): string {
  switch (codec) {
    case "h264":
      return "H.264";
    case "h265":
      return "H.265 / HEVC";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
  }
}
