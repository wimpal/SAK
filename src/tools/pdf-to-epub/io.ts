import { invoke } from "@tauri-apps/api/core";

export interface EpubCleanupReport {
  action: "cleaned" | "skipped" | string;
  removedSpineItems: number;
  skippedReason?: string;
}

export interface ConvertPdfToEpubResult {
  path: string;
  ok: boolean;
  error?: string;
  cleanup?: EpubCleanupReport;
}

export async function pathsExist(paths: string[]): Promise<Map<string, boolean>> {
  if (paths.length === 0) return new Map();
  const flags = await invoke<boolean[]>("paths_exist", { paths });
  const map = new Map<string, boolean>();
  paths.forEach((p, i) => map.set(p, flags[i]));
  return map;
}

export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}

export async function convertPdfToEpub(args: {
  jobId: string;
  sourcePath: string;
  outputPath: string;
  title?: string | null;
}): Promise<ConvertPdfToEpubResult> {
  return invoke<ConvertPdfToEpubResult>("convert_pdf_to_epub", args);
}

export async function cancelEbookConvertJob(jobId: string): Promise<void> {
  await invoke("cancel_ebook_convert_job", { jobId });
}

export async function ebookConvertVersion(): Promise<string> {
  return invoke<string>("ebook_convert_version");
}
