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

export const TARGET_CONTAINERS = ["mp4", "mkv", "mov", "m4v", "ts"] as const;
export type TargetContainer = (typeof TARGET_CONTAINERS)[number];

export const VIDEO_CODECS = ["h264", "h265"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export const RESOLUTION_OPTIONS = [
  { id: "original", label: "Original", height: null },
  { id: "1080", label: "1080p", height: 1080 },
  { id: "720", label: "720p", height: 720 },
  { id: "480", label: "480p", height: 480 },
] as const;
export type ResolutionId = (typeof RESOLUTION_OPTIONS)[number]["id"];

export const REDUCE_MODES = ["target", "quality"] as const;
export type ReduceMode = (typeof REDUCE_MODES)[number];

export const DEFAULT_NAME_PATTERN = "{stem}-smaller";
export const DEFAULT_TARGET_MB = 50;
export const DEFAULT_QUALITY_LEVEL = 5;
export const AUDIO_BITRATE_BPS = 128_000;
export const MIN_VIDEO_BITRATE_KBPS = 100;
export const FIXED_PRESET = "medium";

/** Quality slider: 0 = smaller file, 10 = better quality. */
export const QUALITY_SLIDER = { min: 0, max: 10 } as const;

const CRF_BY_CODEC: Record<VideoCodec, { smaller: number; better: number }> = {
  h264: { smaller: 28, better: 18 },
  h265: { smaller: 32, better: 22 },
};

const CODEC_CONTAINERS: Record<VideoCodec, readonly TargetContainer[]> = {
  h264: ["mp4", "mkv", "mov", "m4v", "ts"],
  h265: ["mp4", "mkv", "mov", "m4v"],
};

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
  sizeBytes: number;
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
  | "reducing"
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
  sourceBytes?: number;
  estimatedBytes?: number;
}

export interface RowResult {
  status: ResultStatus;
  error?: string;
}

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

export function isReduceMode(value: string): value is ReduceMode {
  return (REDUCE_MODES as readonly string[]).includes(value);
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
  return allowed[0];
}

export function codecAllowsContainer(
  codec: VideoCodec,
  container: TargetContainer,
): boolean {
  return containersForCodec(codec).includes(container);
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

export function clampQualityLevel(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_QUALITY_LEVEL;
  return Math.min(
    QUALITY_SLIDER.max,
    Math.max(QUALITY_SLIDER.min, Math.round(value)),
  );
}

/** Map quality slider (0=smaller … 10=better) to CRF for the codec. */
export function crfFromQualityLevel(codec: VideoCodec, level: number): number {
  const clamped = clampQualityLevel(level);
  const { smaller, better } = CRF_BY_CODEC[codec];
  const t = clamped / QUALITY_SLIDER.max;
  return Math.round(smaller - t * (smaller - better));
}

export function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb * 1024 * 1024);
}

export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / (1024 * 1024);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Video bitrate (kbps) needed to hit `targetBytes` after reserving audio.
 * Returns null when duration/target invalid or audio alone exceeds the budget.
 */
export function estimateTargetBitrateKbps(
  targetBytes: number,
  durationSecs: number,
  audioBitrateBps: number = AUDIO_BITRATE_BPS,
): number | null {
  if (durationSecs <= 0 || targetBytes <= 0) return null;
  const totalBps = (targetBytes * 8) / durationSecs;
  const videoBps = totalBps - audioBitrateBps;
  if (videoBps <= 0) return null;
  return Math.floor(videoBps / 1000);
}

export function canHitTarget(
  targetBytes: number,
  durationSecs: number,
): boolean {
  const kbps = estimateTargetBitrateKbps(targetBytes, durationSecs);
  return kbps !== null && kbps >= MIN_VIDEO_BITRATE_KBPS;
}

/**
 * Rough output-size heuristic for quality mode.
 * Higher CRF → smaller file; scaled from source size.
 */
export function estimateQualityBytes(
  sourceBytes: number,
  crf: number,
  codec: VideoCodec,
): number {
  if (sourceBytes <= 0) return 0;
  const refCrf = codec === "h264" ? 23 : 28;
  const steps = crf - refCrf;
  const factor = Math.pow(0.88, steps);
  return Math.max(1, Math.round(sourceBytes * 0.85 * factor));
}

export function estimateOutputBytes(
  mode: ReduceMode,
  opts: {
    targetBytes: number;
    sourceBytes: number;
    crf: number;
    codec: VideoCodec;
  },
): number {
  if (mode === "target") {
    return opts.targetBytes > 0 ? opts.targetBytes : 0;
  }
  return estimateQualityBytes(opts.sourceBytes, opts.crf, opts.codec);
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

export interface BuildPreviewOptions {
  paths: string[];
  targetContainer: TargetContainer;
  outputDir: string | null;
  existsMap: Map<string, boolean>;
  namePattern: string;
  videoCodec: VideoCodec;
  streamsByPath: Map<string, MediaStreamInfo[]>;
  sizesByPath: Map<string, number>;
  durationsByPath: Map<string, number>;
  mode: ReduceMode;
  targetBytes: number;
  qualityLevel: number;
}

export function buildPreview(opts: BuildPreviewOptions): PreviewRow[] {
  const {
    paths,
    targetContainer,
    outputDir,
    existsMap,
    namePattern,
    videoCodec,
    streamsByPath,
    sizesByPath,
    durationsByPath,
    mode,
    targetBytes,
    qualityLevel,
  } = opts;

  const rows: PreviewRow[] = [];
  const seenTargets = new Set<string>();
  const crf = crfFromQualityLevel(videoCodec, qualityLevel);

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
    const sourceBytes = sizesByPath.get(from) ?? 0;
    const durationSecs = durationsByPath.get(from) ?? 0;
    const estimatedBytes = estimateOutputBytes(mode, {
      targetBytes,
      sourceBytes,
      crf,
      codec: videoCodec,
    });

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
      rows.push({
        from,
        to,
        status: "same_file",
        bumped,
        sourceBytes,
        estimatedBytes,
      });
      continue;
    }

    if (existsMap.get(to) === true) {
      rows.push({
        from,
        to,
        status: "exists",
        bumped,
        sourceBytes,
        estimatedBytes,
      });
      continue;
    }

    if (seenTargets.has(toKey)) {
      rows.push({
        from,
        to,
        status: "duplicate",
        bumped,
        sourceBytes,
        estimatedBytes,
      });
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
        sourceBytes,
        estimatedBytes,
      });
      continue;
    }

    if (mode === "target") {
      if (targetBytes <= 0) {
        rows.push({
          from,
          to,
          status: "incompatible",
          bumped,
          warnReason: "Enter a target size greater than 0",
          sourceBytes,
          estimatedBytes,
        });
        continue;
      }

      if (durationSecs <= 0 && streams.length > 0) {
        rows.push({
          from,
          to,
          status: "incompatible",
          bumped,
          warnReason: "Could not read duration",
          sourceBytes,
          estimatedBytes,
        });
        continue;
      }

      if (durationSecs > 0 && !canHitTarget(targetBytes, durationSecs)) {
        const kbps = estimateTargetBitrateKbps(targetBytes, durationSecs);
        rows.push({
          from,
          to,
          status: "incompatible",
          bumped,
          warnReason:
            kbps === null
              ? "Target too small for audio budget"
              : `Target too small (needs ≥${MIN_VIDEO_BITRATE_KBPS} kbps video)`,
          sourceBytes,
          estimatedBytes,
        });
        continue;
      }

      if (sourceBytes > 0 && targetBytes >= sourceBytes) {
        rows.push({
          from,
          to,
          status: "warn",
          bumped,
          warnReason: "Target ≥ source size — may not shrink",
          sourceBytes,
          estimatedBytes,
        });
        continue;
      }
    }

    rows.push({
      from,
      to,
      status: "ready",
      bumped,
      sourceBytes,
      estimatedBytes,
    });
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
      return bumped ? "Warning (renamed)" : "Warning";
    case "same_file":
      return "Same as source";
    case "unsupported":
      return "Unsupported";
    case "exists":
      return "Already exists";
    case "duplicate":
      return "Duplicate in batch";
    case "incompatible":
      return "Cannot reduce";
    case "reducing":
      return "Reducing";
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
    case "reducing":
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
  }
}

export function estimateHint(mode: ReduceMode): string {
  if (mode === "target") {
    return "Aims for target; ±10–20% typical";
  }
  return "Approx.";
}
