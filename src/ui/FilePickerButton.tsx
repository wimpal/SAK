import { open } from "@tauri-apps/plugin-dialog";

interface FilePickerButtonProps {
  label?: string;
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
  onPick: (paths: string[]) => void;
}

export function FilePickerButton({
  label = "Choose files",
  multiple = false,
  directory = false,
  filters,
  onPick,
}: FilePickerButtonProps) {
  async function pick() {
    const selected = await open({ multiple, directory, filters });
    if (!selected) return;
    onPick(Array.isArray(selected) ? selected : [selected]);
  }

  return (
    <button
      onClick={pick}
      className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:border-zinc-500 transition-colors"
    >
      {label}
    </button>
  );
}
