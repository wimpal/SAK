import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import {
  basename,
  buildPreview,
  collectExtensions,
  getExtension,
  isApplyable,
  isValidExt,
  isValidFilterExts,
  normalizeExt,
  parseFilterExts,
  toggleFilterExt,
  type PreviewRow,
} from "./logic";

const STORAGE = {
  newExt: "sak.ext-changer.newExt",
  fromFilter: "sak.ext-changer.fromFilter",
  recursive: "sak.ext-changer.recursive",
} as const;

interface RenameResult {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

interface UndoOp {
  from: string;
  to: string;
}

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota errors */
  }
}

function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota errors */
  }
}

function statusLabel(status: PreviewRow["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "add_ext":
      return "Adding extension";
    case "noop":
      return "No change";
    case "case_only":
      return "Case only";
    case "exists":
      return "Already exists";
    case "duplicate":
      return "Duplicate in batch";
    case "incompatible":
      return "Incompatible type";
  }
}

function statusClass(status: PreviewRow["status"]): string {
  switch (status) {
    case "ready":
    case "add_ext":
    case "case_only":
      return "text-zinc-400";
    case "noop":
      return "text-zinc-600";
    case "exists":
    case "duplicate":
    case "incompatible":
      return "text-brand-soft";
  }
}

export default function ExtChangerTool() {
  const [paths, setPaths] = useState<string[]>([]);
  const [newExt, setNewExt] = useState(() => loadString(STORAGE.newExt));
  const [fromFilter, setFromFilter] = useState(() => loadString(STORAGE.fromFilter));
  const [recursive, setRecursive] = useState(() => loadBool(STORAGE.recursive));
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [applying, setApplying] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoOp[] | null>(null);

  useEffect(() => {
    saveString(STORAGE.newExt, newExt);
  }, [newExt]);

  useEffect(() => {
    saveString(STORAGE.fromFilter, fromFilter);
  }, [fromFilter]);

  useEffect(() => {
    saveBool(STORAGE.recursive, recursive);
  }, [recursive]);

  const addPaths = useCallback(
    async (incoming: string[]) => {
      const expanded = await invoke<string[]>("expand_intake_paths", {
        paths: incoming,
        recursive,
      });
      setPaths((prev) => [...new Set([...prev, ...expanded])]);
      setSummary(null);
      setLastUndo(null);
    },
    [recursive],
  );

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const ext = normalizeExt(newExt);
      if (!isValidExt(ext) || !isValidFilterExts(fromFilter) || paths.length === 0) {
        if (!cancelled) setPreview([]);
        return;
      }

      const filter = fromFilter.trim() ? fromFilter : undefined;
      const draft = buildPreview(paths, ext, filter, new Map());
      const targets = draft
        .filter(
          (r) =>
            r.status !== "noop" &&
            r.from.toLowerCase() !== r.to.toLowerCase(),
        )
        .map((r) => r.to);
      const exists =
        targets.length > 0
          ? await invoke<boolean[]>("paths_exist", { paths: targets })
          : [];

      if (cancelled) return;

      const existsMap = new Map<string, boolean>();
      targets.forEach((target, i) => existsMap.set(target, exists[i]));
      setPreview(buildPreview(paths, ext, filter, existsMap));
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [paths, newExt, fromFilter]);

  async function runRenames(
    ops: UndoOp[],
    onSuccess: (results: RenameResult[]) => void,
  ) {
    if (ops.length === 0) return;
    setApplying(true);
    setSummary(null);
    try {
      const results = await invoke<RenameResult[]>("rename_extensions", { ops });
      onSuccess(results);
    } finally {
      setApplying(false);
    }
  }

  async function apply() {
    const ready = preview.filter((r) => isApplyable(r.status));
    if (ready.length === 0) return;

    await runRenames(
      ready.map((r) => ({ from: r.from, to: r.to })),
      (results) => {
        const renamed = results.filter((r) => r.ok).length;
        const skipped = results.filter(
          (r) => !r.ok && r.error === "target already exists",
        ).length;
        const failed = results.filter(
          (r) => !r.ok && r.error !== "target already exists",
        ).length;

        const okMap = new Map(
          results.filter((r) => r.ok).map((r) => [r.from, r.to]),
        );
        setPaths((prev) => prev.map((p) => okMap.get(p) ?? p));

        if (renamed > 0) {
          setLastUndo(
            results
              .filter((r) => r.ok)
              .map((r) => ({ from: r.to, to: r.from })),
          );
        }

        const parts = [`${renamed} renamed`];
        if (skipped > 0) parts.push(`${skipped} skipped (collision)`);
        if (failed > 0) parts.push(`${failed} failed`);
        setSummary(`${parts.join(", ")}.`);
      },
    );
  }

  async function undo() {
    if (!lastUndo || lastUndo.length === 0) return;

    const ops = lastUndo;
    await runRenames(ops, (results) => {
      const undone = results.filter((r) => r.ok).length;
      const okMap = new Map(
        results.filter((r) => r.ok).map((r) => [r.from, r.to]),
      );
      setPaths((prev) => prev.map((p) => okMap.get(p) ?? p));
      setLastUndo(null);
      setSummary(`${undone} undone.`);
    });
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
    setSummary(null);
    setLastUndo(null);
  }

  function clearAll() {
    setPaths([]);
    setPreview([]);
    setSummary(null);
    setLastUndo(null);
  }

  function toggleChip(ext: string) {
    setFromFilter((prev) => toggleFilterExt(prev, ext));
    setSummary(null);
  }

  const ext = normalizeExt(newExt);
  const extValid = isValidExt(ext);
  const filterValid = isValidFilterExts(fromFilter);
  const filterExts =
    fromFilter.trim() && filterValid ? parseFilterExts(fromFilter) : null;
  const sortedPaths = [...paths].sort((a, b) =>
    basename(a).localeCompare(basename(b)),
  );
  const extensionChips = collectExtensions(paths);
  const applyableCount = preview.filter((r) => isApplyable(r.status)).length;
  const skipCount = preview.filter(
    (r) =>
      r.status === "exists" ||
      r.status === "duplicate" ||
      r.status === "incompatible",
  ).length;
  const incompatibleCount = preview.filter(
    (r) => r.status === "incompatible",
  ).length;
  const showEmptyFilter =
    paths.length > 0 && extValid && filterValid && preview.length === 0;
  const showPreview = preview.length > 0 || showEmptyFilter;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilePickerButton label="Choose files" multiple onPick={addPaths} />
          <FilePickerButton label="Choose folder" directory onPick={addPaths} />
          {paths.length > 0 && (
            <button
              onClick={clearAll}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-900 text-brand focus:ring-brand/50"
          />
          Include subfolders
        </label>
        <p className="text-xs text-zinc-600">
          Applies to the next folder pick or drop.
        </p>

        <DropZone onDrop={addPaths}>Drop files or a folder here</DropZone>

        {paths.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-zinc-300">
              Selected files ({paths.length})
            </h2>

            {extensionChips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extensionChips.map((chipExt) => {
                  const active = filterExts?.includes(chipExt) ?? false;
                  return (
                    <button
                      key={chipExt}
                      type="button"
                      onClick={() => toggleChip(chipExt)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        active
                          ? "bg-brand/20 text-brand-soft border border-brand/50"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500"
                      }`}
                    >
                      .{chipExt}
                    </button>
                  );
                })}
              </div>
            )}

            <ul className="max-h-52 overflow-y-auto rounded-xl border border-zinc-800 divide-y divide-zinc-800">
              {sortedPaths.map((path) => {
                const fileExt = getExtension(path);
                const matchesFilter =
                  !filterExts ||
                  (fileExt !== null && filterExts.includes(fileExt));
                return (
                  <li
                    key={path}
                    className={`flex items-center gap-2 px-3 py-2 ${
                      matchesFilter ? "text-zinc-300" : "text-zinc-600"
                    }`}
                    title={path}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {basename(path)}
                    </span>
                    {fileExt && (
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        .{fileExt}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePath(path)}
                      className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-brand-soft transition-colors"
                      aria-label={`Remove ${basename(path)}`}
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {filterExts && (
              <p className="text-xs text-zinc-500">
                Dimmed files do not match the extension filter.
              </p>
            )}
          </section>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm text-zinc-400">New extension</span>
          <input
            type="text"
            value={newExt}
            onChange={(e) => {
              setNewExt(e.target.value);
              setSummary(null);
            }}
            placeholder="jpg"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          />
          {newExt.trim() && !extValid && (
            <span className="mt-1 block text-xs text-brand-soft">
              Enter a valid extension (letters, numbers, dots, hyphens).
            </span>
          )}
          {incompatibleCount > 0 && extValid && (
            <span className="mt-1 block text-xs text-brand-soft">
              {incompatibleCount} file(s) cannot use .{ext} — types must match
              (video → video, image → image, etc.).
            </span>
          )}
        </label>
        <label className="block">
          <span className="text-sm text-zinc-400">
            Only files ending in (optional, comma-separated)
          </span>
          <input
            type="text"
            value={fromFilter}
            onChange={(e) => {
              setFromFilter(e.target.value);
              setSummary(null);
            }}
            placeholder="jpeg, jpg, png"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          />
          {fromFilter.trim() && !filterValid && (
            <span className="mt-1 block text-xs text-brand-soft">
              Use valid extensions separated by commas.
            </span>
          )}
        </label>
      </section>

      {showPreview && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-zinc-300">
              {showEmptyFilter
                ? `Preview — 0 of ${paths.length} files`
                : `Preview — ${applyableCount} of ${paths.length} files`}
            </h2>
            {skipCount > 0 && (
              <span className="text-xs text-brand-soft">
                {skipCount} will be skipped
              </span>
            )}
          </div>

          {showEmptyFilter ? (
            <p className="text-sm text-zinc-500">
              0 of {paths.length} files match the filter.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">From</th>
                    <th className="px-4 py-2 font-medium">To</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => (
                    <tr
                      key={row.from}
                      className="border-t border-zinc-800 even:bg-zinc-900/40"
                    >
                      <td className="px-4 py-2 font-mono text-xs text-zinc-300">
                        {basename(row.from)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-zinc-300">
                        {basename(row.to)}
                      </td>
                      <td
                        className={`px-4 py-2 text-xs ${statusClass(row.status)}`}
                      >
                        {statusLabel(row.status)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="flex flex-wrap items-center gap-4">
        <button
          onClick={apply}
          disabled={!extValid || !filterValid || applyableCount === 0 || applying}
          className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          {applying ? "Renaming…" : `Apply (${applyableCount})`}
        </button>
        {lastUndo && lastUndo.length > 0 && (
          <button
            onClick={undo}
            disabled={applying}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          >
            Undo
          </button>
        )}
        {summary && <p className="text-sm text-zinc-400">{summary}</p>}
      </section>
    </div>
  );
}
