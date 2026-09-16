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

export const DEFAULT_NAME_PATTERN = "{stem}-remuxed";

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
  | "same_container"
  | "unsupported"
  | "exists"
  | "duplicate"
  | "warn"
  | "incompatible";

export type ResultStatus =
  | PreviewStatus
  | "remuxing"
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

const MP4_FAMILY_INCOMPATIBLE_SUBTITLE = [
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "xsub",
];

const MP4_FAMILY_WARN_AUDIO = ["ac3", "eac3"];

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

export function isValidOutputStem(name: string): boolean {
  return sanitizeOutputStem(name).length > 0;
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

export type StreamCompat = "ok" | "warn" | "incompatible";

export function streamCompatibility(
  stream: MediaStreamInfo,
  container: TargetContainer,
): StreamCompat {
  const codec = stream.codecName.toLowerCase();
  const type = stream.codecType.toLowerCase();

  if (container === "mkv") {
    return "ok";
  }

  if (
    container === "mp4" ||
    container === "mov" ||
    container === "m4v"
  ) {
    if (type === "audio" && MP4_FAMILY_INCOMPATIBLE_AUDIO.includes(codec)) {
      return "incompatible";
    }
    if (
      type === "subtitle" &&
      MP4_FAMILY_INCOMPATIBLE_SUBTITLE.includes(codec)
    ) {
      return "incompatible";
    }
    if (type === "audio" && MP4_FAMILY_WARN_AUDIO.includes(codec)) {
      return "warn";
    }
    return "ok";
  }

  if (container === "webm") {
    if (type === "video") {
      return codec === "vp8" || codec === "vp9" ? "ok" : "incompatible";
    }
    if (type === "audio") {
      return codec === "opus" || codec === "vorbis" ? "ok" : "incompatible";
    }
    if (type === "subtitle") {
      return "incompatible";
    }
    return "ok";
  }

  if (container === "ts") {
    if (
      type === "subtitle" &&
      MP4_FAMILY_INCOMPATIBLE_SUBTITLE.includes(codec)
    ) {
      return "incompatible";
    }
    return "ok";
  }

  return "ok";
}

export function compatibleStreamIndices(
  streams: MediaStreamInfo[],
  container: TargetContainer,
): number[] {
  return streams
    .filter((stream) => streamCompatibility(stream, container) !== "incompatible")
    .map((stream) => stream.index);
}

export function streamIndicesForRemux(
  streams: MediaStreamInfo[],
  container: TargetContainer,
  dropIncompatible: boolean,
  selectedIndices: number[] | null,
): number[] {
  if (selectedIndices !== null) {
    return selectedIndices;
  }

  if (dropIncompatible) {
    return compatibleStreamIndices(streams, container);
  }

  return streams.map((stream) => stream.index);
}

function worstCompat(
  streams: MediaStreamInfo[],
  indices: number[],
  container: TargetContainer,
): StreamCompat {
  let worst: StreamCompat = "ok";
  for (const index of indices) {
    const stream = streams.find((s) => s.index === index);
    if (!stream) continue;
    const compat = streamCompatibility(stream, container);
    if (compat === "incompatible") {
      worst = "incompatible";
    } else if (compat === "warn" && worst !== "incompatible") {
      worst = "warn";
    }
  }
  return worst;
}

export function warnReasonForStreams(
  streams: MediaStreamInfo[],
  indices: number[],
  container: TargetContainer,
): string | undefined {
  const parts: string[] = [];
  for (const index of indices) {
    const stream = streams.find((s) => s.index === index);
    if (!stream) continue;
    const compat = streamCompatibility(stream, container);
    if (compat === "warn") {
      parts.push(`${stream.codecType} ${stream.codecName}`);
    } else if (compat === "incompatible") {
      parts.push(`${stream.codecType} ${stream.codecName} unsupported`);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join(", ");
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
  streamsByPath: Map<string, MediaStreamInfo[]>,
  dropIncompatible: boolean,
  selectedStreamIndices: number[] | null,
): PreviewRow[] {
  const seenTargets = new Set<string>();
  const rows: PreviewRow[] = [];
  const singleFile = paths.length === 1;

  for (let i = 0; i < paths.length; i++) {
    const from = paths[i];
    if (!isVideoPath(from)) {
      rows.push({ from, to: from, status: "unsupported" });
      continue;
    }

    const streams = streamsByPath.get(from) ?? [];
    const initialStem = applyNamePattern(
      namePattern,
      fileStem(from),
      i + 1,
    );
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
      rows.push({ from, to, status: "same_container", bumped });
      continue;
    }

    const sourceExt = fileExtension(from);
    if (sourceExt === targetContainer && !bumped) {
      rows.push({ from, to, status: "same_container", bumped });
      continue;
    }

    const indices = streamIndicesForRemux(
      streams,
      targetContainer,
      dropIncompatible,
      singleFile ? selectedStreamIndices : null,
    );

    if (streams.length > 0) {
      if (indices.length === 0) {
        rows.push({
          from,
          to,
          status: "incompatible",
          bumped,
          warnReason: "No streams selected",
        });
        continue;
      }

      const compat = worstCompat(streams, indices, targetContainer);
      const warnReason = warnReasonForStreams(
        streams,
        indices,
        targetContainer,
      );

      if (compat === "incompatible" && !dropIncompatible) {
        rows.push({
          from,
          to,
          status: "incompatible",
          bumped,
          warnReason,
        });
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

      if (compat === "warn") {
        rows.push({
          from,
          to,
          status: "warn",
          bumped,
          warnReason,
        });
        continue;
      }

      rows.push({ from, to, status: "ready", bumped });
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
      return bumped ? "May fail (renamed)" : "May fail";
    case "same_container":
      return "Same container";
    case "unsupported":
      return "Unsupported";
    case "exists":
      return "Already exists";
    case "duplicate":
      return "Duplicate in batch";
    case "incompatible":
      return "Incompatible streams";
    case "remuxing":
      return "Remuxing";
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
    case "remuxing":
      return "text-zinc-300";
    case "same_container":
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

export function streamLabel(stream: MediaStreamInfo): string {
  const parts = [
    stream.codecType,
    stream.codecName,
    `#${stream.index}`,
  ];
  if (stream.language) parts.push(stream.language);
  if (stream.title) parts.push(stream.title);
  return parts.join(" · ");
}
