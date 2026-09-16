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

/** Containers we can write (same set as remux / encode). */
export const SUPPORTED_CONTAINERS = [
  "mp4",
  "mkv",
  "mov",
  "webm",
  "ts",
  "m4v",
] as const;
export type SupportedContainer = (typeof SUPPORTED_CONTAINERS)[number];

export const AUDIO_CODECS = ["aac", "opus"] as const;
export type AudioCodec = (typeof AUDIO_CODECS)[number];

export const AAC_BITRATES = [96, 128, 192, 256] as const;
export const OPUS_BITRATES = [64, 96, 128, 160] as const;

export const DEFAULT_AAC_BITRATE = 192;
export const DEFAULT_OPUS_BITRATE = 128;

export const DEFAULT_NAME_PATTERN = "{stem}-audio";

export interface MediaStreamInfo {
  index: number;
  codecType: string;
  codecName: string;
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
  | "incompatible"
  | "no_audio";

export type ResultStatus =
  | PreviewStatus
  | "converting"
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

export function isSupportedContainer(
  value: string,
): value is SupportedContainer {
  return (SUPPORTED_CONTAINERS as readonly string[]).includes(value);
}

export function isAudioCodec(value: string): value is AudioCodec {
  return (AUDIO_CODECS as readonly string[]).includes(value);
}

export function containerFromPath(path: string): SupportedContainer | null {
  const ext = fileExtension(path);
  if (ext === null || !isSupportedContainer(ext)) return null;
  return ext;
}

/** Default target codec for a container (Opus for WebM, AAC otherwise). */
export function defaultCodecForContainer(
  container: SupportedContainer,
): AudioCodec {
  return container === "webm" ? "opus" : "aac";
}

export function defaultCodecForExt(ext: string | null): AudioCodec {
  if (ext !== null && isSupportedContainer(ext)) {
    return defaultCodecForContainer(ext);
  }
  return "aac";
}

export function codecAllowedForContainer(
  codec: AudioCodec,
  container: SupportedContainer,
): boolean {
  if (container === "webm") return codec === "opus";
  return true;
}

export function bitrateOptionsFor(codec: AudioCodec): readonly number[] {
  return codec === "aac" ? AAC_BITRATES : OPUS_BITRATES;
}

export function defaultBitrateFor(codec: AudioCodec): number {
  return codec === "aac" ? DEFAULT_AAC_BITRATE : DEFAULT_OPUS_BITRATE;
}

export function isValidBitrate(codec: AudioCodec, bitrate: number): boolean {
  return (bitrateOptionsFor(codec) as readonly number[]).includes(bitrate);
}

export function clampBitrate(codec: AudioCodec, bitrate: number): number {
  if (isValidBitrate(codec, bitrate)) return bitrate;
  return defaultBitrateFor(codec);
}

export function codecLabel(codec: AudioCodec): string {
  switch (codec) {
    case "aac":
      return "AAC";
    case "opus":
      return "Opus";
  }
}

export function sanitizeOutputStem(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  for (const ext of [...VIDEO_EXTENSIONS, ...SUPPORTED_CONTAINERS]) {
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
  container: SupportedContainer,
  outputStem?: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  const stem = outputStem ?? defaultOutputStem(sourcePath);
  return joinPath(dir, `${stem}.${container}`);
}

function samePathIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function hasAudioStream(streams: MediaStreamInfo[]): boolean {
  return streams.some((stream) => stream.codecType.toLowerCase() === "audio");
}

export function hasVideoStream(streams: MediaStreamInfo[]): boolean {
  return streams.some((stream) => stream.codecType.toLowerCase() === "video");
}

export function sourceAudioCodecLabel(
  streams: MediaStreamInfo[],
): string | null {
  const audio = streams.find(
    (stream) => stream.codecType.toLowerCase() === "audio",
  );
  return audio ? audio.codecName.toUpperCase() : null;
}

export function resolveStemAvoidingCollision(
  initialStem: string,
  sourcePath: string,
  outputDir: string | null,
  container: SupportedContainer,
  existsMap: Map<string, boolean>,
): { stem: string; bumped: boolean } {
  const base = initialStem.match(/^(.*)-(\d+)$/)?.[1] ?? initialStem;
  let candidate = initialStem;
  let bumped = false;
  let n = 2;

  for (let guard = 0; guard < 10000; guard++) {
    const to = outputPath(sourcePath, outputDir, container, candidate);
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
  audioCodec: AudioCodec,
  bitrateKbps: number,
  outputDir: string | null,
  existsMap: Map<string, boolean>,
  namePattern: string,
  streamsByPath: Map<string, MediaStreamInfo[]>,
): PreviewRow[] {
  const seenTargets = new Set<string>();
  const rows: PreviewRow[] = [];

  for (let i = 0; i < paths.length; i++) {
    const from = paths[i];
    if (!isVideoPath(from)) {
      rows.push({ from, to: from, status: "unsupported" });
      continue;
    }

    const container = containerFromPath(from);
    if (container === null) {
      rows.push({
        from,
        to: from,
        status: "unsupported",
        warnReason: "Container not supported — use mp4, mkv, mov, webm, ts, or m4v",
      });
      continue;
    }

    if (!codecAllowedForContainer(audioCodec, container)) {
      rows.push({
        from,
        to: from,
        status: "incompatible",
        warnReason: `AAC is not valid in .${container} — use Opus`,
      });
      continue;
    }

    if (!isValidBitrate(audioCodec, bitrateKbps)) {
      rows.push({
        from,
        to: from,
        status: "incompatible",
        warnReason: `Invalid ${codecLabel(audioCodec)} bitrate`,
      });
      continue;
    }

    const streams = streamsByPath.get(from) ?? [];
    const initialStem = applyNamePattern(namePattern, fileStem(from), i + 1);
    const { stem, bumped } = resolveStemAvoidingCollision(
      initialStem,
      from,
      outputDir,
      container,
      existsMap,
    );
    const to = outputPath(from, outputDir, container, stem);
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

    if (streams.length > 0 && !hasVideoStream(streams)) {
      rows.push({
        from,
        to,
        status: "incompatible",
        bumped,
        warnReason: "No video stream",
      });
      continue;
    }

    if (streams.length > 0 && !hasAudioStream(streams)) {
      rows.push({
        from,
        to,
        status: "no_audio",
        bumped,
        warnReason: "No audio stream",
      });
      continue;
    }

    const sourceCodec = sourceAudioCodecLabel(streams);
    const warnReason = sourceCodec
      ? `${sourceCodec} → ${codecLabel(audioCodec)} ${bitrateKbps}k`
      : `${codecLabel(audioCodec)} ${bitrateKbps}k`;

    rows.push({
      from,
      to,
      status: "ready",
      bumped,
      warnReason,
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
      return bumped ? "Ready (renamed)" : "Ready";
    case "no_audio":
      return "No audio";
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
    case "converting":
      return "Converting";
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
    case "converting":
      return "text-zinc-300";
    case "same_file":
    case "skipped":
    case "cancelled":
    case "no_audio":
      return "text-zinc-600";
    case "unsupported":
    case "exists":
    case "duplicate":
    case "incompatible":
    case "failed":
      return "text-brand-soft";
  }
}
