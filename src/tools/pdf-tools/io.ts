import { invoke } from "@tauri-apps/api/core";

export interface WriteFileResult {
  path: string;
  ok: boolean;
  error?: string;
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  return new Uint8Array(bytes);
}

export async function writeFileBytes(
  path: string,
  bytes: Uint8Array,
): Promise<WriteFileResult> {
  return invoke<WriteFileResult>("write_file_bytes", {
    path,
    bytes: Array.from(bytes),
  });
}

export async function ensureDir(path: string): Promise<void> {
  await invoke("ensure_dir", { path });
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

export async function trashFile(path: string): Promise<void> {
  await invoke("trash_file", { path });
}

export async function renameFileIfAbsent(
  from: string,
  to: string,
): Promise<void> {
  await invoke("rename_file_if_absent", { from, to });
}

export async function expandIntakePaths(
  paths: string[],
  recursive = false,
): Promise<string[]> {
  return invoke<string[]>("expand_intake_paths", { paths, recursive });
}
