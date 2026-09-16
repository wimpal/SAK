import { invoke } from "@tauri-apps/api/core";

export interface ConvertPdfToMarkdownResult {
  path: string;
  ok: boolean;
  error?: string;
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

export async function convertPdfToMarkdown(args: {
  jobId: string;
  sourcePath: string;
  outputPath: string;
  title?: string | null;
}): Promise<ConvertPdfToMarkdownResult> {
  return invoke<ConvertPdfToMarkdownResult>("convert_pdf_to_markdown", args);
}

export async function cancelEbookConvertJob(jobId: string): Promise<void> {
  await invoke("cancel_ebook_convert_job", { jobId });
}

export async function ebookConvertVersion(): Promise<string> {
  return invoke<string>("ebook_convert_version");
}
