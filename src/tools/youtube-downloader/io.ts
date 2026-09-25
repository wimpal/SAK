import { invoke } from "@tauri-apps/api/core";

export interface YoutubeResolveResult {
  title: string;
  channel?: string | null;
  durationSecs?: number | null;
  thumbnailUrl?: string | null;
  webpageUrl: string;
  videoId: string;
}

export interface YoutubeDownloadResult {
  ok: boolean;
  error?: string | null;
  path?: string | null;
  subtitlePaths?: string[];
}

export async function musicToolsVersion(): Promise<string> {
  return invoke<string>("music_tools_version");
}

export async function youtubeResolve(url: string): Promise<YoutubeResolveResult> {
  return invoke<YoutubeResolveResult>("youtube_resolve", { url });
}

export async function youtubeDownload(args: {
  jobId: string;
  url: string;
  outputDir: string;
  titleHint?: string | null;
  maxHeight?: number | null;
  writeSubs?: boolean | null;
}): Promise<YoutubeDownloadResult> {
  return invoke<YoutubeDownloadResult>("youtube_download", args);
}

export async function cancelYoutubeJob(jobId: string): Promise<void> {
  await invoke("cancel_youtube_job", { jobId });
}

export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}
