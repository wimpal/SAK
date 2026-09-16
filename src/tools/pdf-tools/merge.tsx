import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  defaultMergedStem,
  formatPageCountPreview,
  isValidOutputStem,
  moveIndex,
  parsePageRanges,
  pdfOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";
import {
  pathsExist,
  readFileBytes,
  revealInExplorer,
  writeFileBytes,
} from "./io";
import { getPageCount, mergePdfs } from "./pdfOps";

interface MergeModeProps {
  paths: string[];
  onError: (message: string | null) => void;
}

interface MergeRow {
  path: string;
  pageCount: number | null;
  rangeInput: string;
  loadError?: string;
}

export function MergeMode({ paths, onError }: MergeModeProps) {
  const [rows, setRows] = useState<MergeRow[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputStem, setOutputStem] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setOutputDir(null);

    if (paths.length === 0) {
      setRows([]);
      setOutputStem("");
      return;
    }

    setOutputStem(sanitizeOutputStem(defaultMergedStem(paths[0])));

    (async () => {
      const next: MergeRow[] = [];
      for (const path of paths) {
        try {
          const bytes = await readFileBytes(path);
          const count = await getPageCount(bytes);
          next.push({ path, pageCount: count, rangeInput: "all" });
        } catch (err) {
          next.push({
            path,
            pageCount: null,
            rangeInput: "all",
            loadError:
              err instanceof Error ? err.message : "Failed to read PDF",
          });
        }
      }
      if (!cancelled) setRows(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [paths]);

  const preview = useMemo(() => {
    const entries: { label: string; count: number }[] = [];
    let error: string | null = null;

    for (const row of rows) {
      if (row.pageCount === null) {
        error = row.loadError ?? `Could not read ${basename(row.path)}`;
        break;
      }
      const parsed = parsePageRanges(row.rangeInput, row.pageCount);
      if ("error" in parsed) {
        error = `${basename(row.path)}: ${parsed.error}`;
        break;
      }
      entries.push({
        label: basename(row.path),
        count: parsed.indices.length,
      });
    }

    return { entries, error, total: entries.reduce((s, e) => s + e.count, 0) };
  }, [rows]);

  const updateRange = (index: number, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, rangeInput: value } : r)),
    );
  };

  const onDrop = (listIndex: number) => {
    if (dragFrom === null) return;
    setRows((prev) => moveIndex(prev, dragFrom, listIndex));
    setDragFrom(null);
  };

  const runMerge = useCallback(async () => {
    if (rows.length === 0) return;
    if (preview.error) {
      onError(preview.error);
      return;
    }
    if (preview.total === 0) {
      onError("Nothing to merge — check page ranges.");
      return;
    }
    if (!isValidOutputStem(outputStem)) {
      onError("Enter a valid output name.");
      return;
    }

    setBusy(true);
    setProgress(0.05);
    onError(null);
    try {
      const entries: { bytes: Uint8Array; pageIndices: number[] }[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.pageCount === null) continue;
        const parsed = parsePageRanges(row.rangeInput, row.pageCount);
        if ("error" in parsed) throw new Error(parsed.error);
        const bytes = await readFileBytes(row.path);
        entries.push({ bytes, pageIndices: parsed.indices });
        setProgress(0.1 + (0.5 * (i + 1)) / rows.length);
      }

      const merged = await mergePdfs(entries);
      setProgress(0.7);

      const sourcePath = rows[0].path;
      const base = sanitizeOutputStem(outputStem);
      const probe: string[] = [];
      for (let n = 0; n < 40; n++) {
        probe.push(
          pdfOutputPath(
            sourcePath,
            outputDir,
            n === 0 ? base : `${base}-${n + 1}`,
          ),
        );
      }
      const existsMap = await pathsExist(probe);
      const resolved = resolveStemAvoidingCollision(base, existsMap, (s) =>
        pdfOutputPath(sourcePath, outputDir, s),
      );

      const result = await writeFileBytes(resolved.path, merged);
      if (!result.ok) throw new Error(result.error ?? "Write failed");
      setProgress(1);
      setSummary(
        `Merged ${formatPageCountPreview(preview.entries)} → ${basename(result.path)}`,
      );
      await revealInExplorer(result.path);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }, [rows, preview, outputStem, outputDir, onError]);

  if (paths.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Pick or drop two or more PDFs (or a folder) to merge.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {rows.map((row, i) => (
          <li
            key={row.path}
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 cursor-grab active:cursor-grabbing"
          >
            <span className="text-xs text-zinc-500 w-6">{i + 1}</span>
            <span
              className="flex-1 min-w-[10rem] text-sm truncate"
              title={row.path}
            >
              {basename(row.path)}
              {row.pageCount !== null ? (
                <span className="text-zinc-500"> · {row.pageCount}p</span>
              ) : (
                <span className="text-red-400"> · error</span>
              )}
            </span>
            <label className="flex items-center gap-1 text-xs text-zinc-400">
              Pages
              <input
                value={row.rangeInput}
                onChange={(e) => updateRange(i, e.target.value)}
                placeholder="all or 1-3, 7"
                className="w-36 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
              />
            </label>
          </li>
        ))}
      </ul>

      <p className="text-sm text-zinc-400">
        {preview.error ? (
          <span className="text-red-400">{preview.error}</span>
        ) : (
          <>Preview: {formatPageCountPreview(preview.entries)}</>
        )}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-zinc-400">
          Output name
          <input
            value={outputStem}
            onChange={(e) => setOutputStem(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-zinc-100 min-w-[14rem]"
          />
        </label>
        <button
          type="button"
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500"
          onClick={async () => {
            const dir = await open({ directory: true, multiple: false });
            if (typeof dir === "string") setOutputDir(dir);
          }}
        >
          {outputDir ? "Change folder…" : "Output folder…"}
        </button>
        {outputDir && (
          <button
            type="button"
            className="text-sm text-zinc-500 hover:text-zinc-300"
            onClick={() => setOutputDir(null)}
          >
            Use first file&apos;s folder
          </button>
        )}
        <button
          type="button"
          disabled={busy || !!preview.error || preview.total === 0}
          onClick={() => void runMerge()}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
        >
          Merge
        </button>
      </div>

      {busy && <ProgressBar value={progress} label="Merging…" />}
      {summary && <p className="text-sm text-zinc-300">{summary}</p>}
      <p className="text-xs text-zinc-500">
        Drag rows to set block order. Page ranges are 1-based (e.g.{" "}
        <code className="text-zinc-400">1-3, 7</code> or{" "}
        <code className="text-zinc-400">all</code>).
      </p>
    </div>
  );
}
