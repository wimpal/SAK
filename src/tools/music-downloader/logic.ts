const INVALID = /[\\/:*?"<>|]/g;
const FEAT_SUFFIX =
  /\s*[\(\[](?:ft\.|feat\.|featuring|with)\b[^)\]]*[\)\]]/gi;
const MAX_OUTPUT_STEM_CHARS = 120;

function primaryArtist(artist: string): string {
  return (artist.split(",")[0]?.split("&")[0] ?? artist).trim();
}

function searchTitle(title: string): string {
  return title.replace(FEAT_SUFFIX, "").trim().replace(/\s+/g, " ");
}

export function sanitizeOutputStem(artist: string, title: string): string {
  const stem = `${primaryArtist(artist)} - ${searchTitle(title)}`
    .replace(INVALID, "_")
    .trim()
    .replace(/\.+$/, "");
  if (!stem) return "track";
  return stem.length > MAX_OUTPUT_STEM_CHARS
    ? stem.slice(0, MAX_OUTPUT_STEM_CHARS).trim()
    : stem;
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return "—";
  const total = Math.round(secs);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case "youtube":
      return "YouTube";
    case "spotify":
      return "Spotify";
    default:
      return platform;
  }
}

export function isLikelyMusicUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed.includes("youtube.com/") ||
    trimmed.includes("music.youtube.com/") ||
    trimmed.includes("youtu.be/") ||
    trimmed.includes("open.spotify.com/")
  );
}

export function makeJobId(): string {
  return `music-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const STORAGE = {
  outputDir: "sak.music-downloader.outputDir",
  spotifyClientId: "sak.music-downloader.spotifyClientId",
  spotifyClientSecret: "sak.music-downloader.spotifyClientSecret",
  showSpotifyCreds: "sak.music-downloader.showSpotifyCreds",
  mp3BitrateKbps: "sak.music-downloader.mp3BitrateKbps",
} as const;

export const MP3_BITRATES = [320, 256, 192, 128] as const;
export type Mp3BitrateKbps = (typeof MP3_BITRATES)[number];
export const DEFAULT_MP3_BITRATE: Mp3BitrateKbps = 320;

export function clampMp3Bitrate(bitrate: number): Mp3BitrateKbps {
  if ((MP3_BITRATES as readonly number[]).includes(bitrate)) {
    return bitrate as Mp3BitrateKbps;
  }
  return DEFAULT_MP3_BITRATE;
}

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
