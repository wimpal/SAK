import { invoke } from "@tauri-apps/api/core";

export interface MusicTrackPreview {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  durationSecs?: number | null;
  thumbnailUrl?: string | null;
  source: string;
  downloadQuery: string;
  originalUrl?: string | null;
}

export interface MusicResolveResult {
  platform: string;
  title?: string | null;
  tracks: MusicTrackPreview[];
  notice?: string | null;
}

export interface MusicDownloadItem {
  id: string;
  title: string;
  artist: string;
  downloadQuery: string;
  outputStem?: string | null;
  durationSecs?: number | null;
}

export interface MusicDownloadResult {
  id: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface MusicDownloadJobResult {
  ok: boolean;
  error?: string;
  results: MusicDownloadResult[];
}

export async function musicToolsVersion(): Promise<string> {
  return invoke<string>("music_tools_version");
}

export async function musicResolve(args: {
  url: string;
  spotifyClientId?: string | null;
  spotifyClientSecret?: string | null;
}): Promise<MusicResolveResult> {
  return invoke<MusicResolveResult>("music_resolve", args);
}

export async function musicDownload(args: {
  jobId: string;
  outputDir: string;
  items: MusicDownloadItem[];
  audioQualityKbps?: number;
}): Promise<MusicDownloadJobResult> {
  return invoke<MusicDownloadJobResult>("music_download", args);
}

export async function cancelMusicJob(jobId: string): Promise<void> {
  await invoke("cancel_music_job", { jobId });
}

export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}
