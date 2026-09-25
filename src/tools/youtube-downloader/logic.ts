export function sanitizeVideoStem(title: string): string {
  const INVALID = /[\\/:*?"<>|%\x00-\x1f]/g;
  const RESERVED = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
  ]);
  const MAX = 120;

  let cleaned = title
    .replace(INVALID, "_")
    .trim()
    .replace(/[.\s]+$/g, "");
  if (!cleaned) cleaned = "video";
  const upper = cleaned.toUpperCase();
  if (RESERVED.has(upper) || [...RESERVED].some((r) => upper.startsWith(`${r}.`))) {
    cleaned = `_${cleaned}`;
  }
  return cleaned.length > MAX ? cleaned.slice(0, MAX).trimEnd() : cleaned;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function validateVideoId(id: string): string | null {
  const trimmed = id.trim();
  return VIDEO_ID_RE.test(trimmed) ? trimmed : null;
}

/** Fast client-side gate mirroring Rust `parse_youtube_video_url`. */
export function isYoutubeVideoUrl(value: string): boolean {
  return parseYoutubeVideoUrl(value) !== null;
}

export function parseYoutubeVideoUrl(
  value: string,
): { canonical: string; videoId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  let videoId: string | null = null;

  if (host === "youtu.be") {
    videoId = validateVideoId(parsed.pathname.split("/").filter(Boolean)[0] ?? "");
  } else if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const first = (parts[0] ?? "").toLowerCase();
    if (first === "watch") {
      videoId = validateVideoId(parsed.searchParams.get("v") ?? "");
    } else if (first === "shorts" || first === "live" || first === "embed" || first === "v") {
      videoId = validateVideoId(parts[1] ?? "");
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!videoId) return null;
  return {
    canonical: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return "—";
  const total = Math.round(secs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function makeJobId(): string {
  return `youtube-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Max height presets; 0 = best available (uncapped). */
export const QUALITY_PRESETS = [
  { value: 2160, label: "2160p (4K)" },
  { value: 1440, label: "1440p" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
  { value: 0, label: "Best available" },
] as const;

export type QualityPreset = (typeof QUALITY_PRESETS)[number]["value"];
export const DEFAULT_QUALITY: QualityPreset = 1080;

export function clampQuality(value: number): QualityPreset {
  if ((QUALITY_PRESETS as readonly { value: number }[]).some((p) => p.value === value)) {
    return value as QualityPreset;
  }
  return DEFAULT_QUALITY;
}

export function qualityLabel(value: QualityPreset): string {
  return QUALITY_PRESETS.find((p) => p.value === value)?.label ?? "1080p";
}

export const STORAGE = {
  outputDir: "sak.youtube-downloader.outputDir",
  maxHeight: "sak.youtube-downloader.maxHeight",
  writeSubs: "sak.youtube-downloader.writeSubs",
} as const;

export function loadString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function loadBool(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "true";
  } catch {
    return fallback;
  }
}

export function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}
