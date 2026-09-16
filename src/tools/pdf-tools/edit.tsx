import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  defaultEditedStem,
  isValidOutputStem,
  moveIndex,
  pdfOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";
import {
  pathsExist,
  readFileBytes,
  renameFileIfAbsent,
  revealInExplorer,
  trashFile,
  writeFileBytes,
} from "./io";
import {
  deletePages,
  extractPages,
  insertBlankPage,
  insertPagesFromPdf,
  rotatePages,
  reorderPages,
} from "./pdfOps";
import { loadPdfDocument, renderPageThumbnail } from "./pdfjs";

interface EditModeProps {
  sourcePath: string | null;
  bytes: Uint8Array | null;
  onBytesChange: (bytes: Uint8Array) => void;
  onError: (message: string | null) => void;
}

interface PageItem {
  /** Index in the current PDF bytes. */
  docIndex: number;
  thumb: string | null;
  selected: boolean;
}

async function probeCollision(
  sourcePath: string,
  outputDir: string | null,
  stem: string,
): Promise<{ path: string; stem: string }> {
  const base = sanitizeOutputStem(stem);
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
  // Also include the exact stems resolveStem will try
  const existsMap = await pathsExist(probe);
  return resolveStemAvoidingCollision(base, existsMap, (s) =>
    pdfOutputPath(sourcePath, outputDir, s),
  );
}

export function EditMode({
  sourcePath,
  bytes,
  onBytesChange,
  onError,
}: EditModeProps) {
  const [pages, setPages] = useState<PageItem[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputStem, setOutputStem] = useState("");
  const [replaceOriginal, setReplaceOriginal] = useState(false);
  const [insertAt, setInsertAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const refreshThumbs = useCallback(async (data: Uint8Array) => {
    const doc = await loadPdfDocument(data);
    const items: PageItem[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      let thumb: string | null = null;
      try {
        thumb = await renderPageThumbnail(doc, i, 120);
      } catch {
        thumb = null;
      }
      items.push({ docIndex: i, thumb, selected: false });
    }
    await doc.cleanup();
    setPages(items);
    setInsertAt(items.length);
  }, []);

  useEffect(() => {
    if (!sourcePath) {
      setOutputStem("");
      setOutputDir(null);
      setReplaceOriginal(false);
      return;
    }
    setOutputStem(sanitizeOutputStem(defaultEditedStem(sourcePath)));
    setOutputDir(null);
    setReplaceOriginal(false);
    setSummary(null);
  }, [sourcePath]);

  useEffect(() => {
    if (!bytes) {
      setPages([]);
      return;
    }
    void refreshThumbs(bytes).catch((err) =>
      onError(err instanceof Error ? err.message : "Failed to load pages"),
    );
  }, [bytes, refreshThumbs, onError]);

  const selectedDocIndices = useMemo(
    () => pages.filter((p) => p.selected).map((p) => p.docIndex),
    [pages],
  );

  const orderDirty = useMemo(
    () => pages.some((p, i) => p.docIndex !== i),
    [pages],
  );

  const applyBytes = useCallback(
    (next: Uint8Array) => {
      onBytesChange(next);
    },
    [onBytesChange],
  );

  const toggleSelect = (listIndex: number) => {
    setPages((prev) =>
      prev.map((p, i) =>
        i === listIndex ? { ...p, selected: !p.selected } : p,
      ),
    );
  };

  const onDrop = (listIndex: number) => {
    if (dragFrom === null) return;
    setPages((prev) => moveIndex(prev, dragFrom, listIndex));
    setDragFrom(null);
  };

  const applyReorder = async () => {
    if (!bytes || !orderDirty) return;
    setBusy(true);
    onError(null);
    try {
      const order = pages.map((p) => p.docIndex);
      const next = await reorderPages(bytes, order);
      applyBytes(next);
      setSummary("Pages reordered (unsaved).");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Reorder failed");
    } finally {
      setBusy(false);
    }
  };

  const rotateSelected = async (delta: number) => {
    if (!bytes || selectedDocIndices.length === 0) return;
    setBusy(true);
    onError(null);
    try {
      let working = bytes;
      if (orderDirty) {
        working = await reorderPages(bytes, pages.map((p) => p.docIndex));
      }
      const indices = pages
        .map((p, i) => (p.selected ? i : -1))
        .filter((i) => i >= 0);
      // If we flushed reorder, selection maps to list positions
      const next = await rotatePages(
        working,
        orderDirty ? indices : selectedDocIndices,
        delta,
      );
      applyBytes(next);
      setSummary(`Rotated ${indices.length} page(s).`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Rotate failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!bytes) return;
    if (selectedDocIndices.length === 0) return;
    if (selectedDocIndices.length >= pages.length) {
      onError("Cannot delete all pages.");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      let working = bytes;
      let indices = selectedDocIndices;
      if (orderDirty) {
        working = await reorderPages(bytes, pages.map((p) => p.docIndex));
        indices = pages
          .map((p, i) => (p.selected ? i : -1))
          .filter((i) => i >= 0);
      }
      const next = await deletePages(working, indices);
      applyBytes(next);
      setSummary(`Deleted ${indices.length} page(s).`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const extractSelected = async () => {
    if (!bytes || !sourcePath) return;
    if (selectedDocIndices.length === 0) {
      onError("Select pages to extract.");
      return;
    }
    setBusy(true);
    setProgress(0.2);
    onError(null);
    try {
      let working = bytes;
      let indices = selectedDocIndices;
      if (orderDirty) {
        working = await reorderPages(bytes, pages.map((p) => p.docIndex));
        indices = pages
          .map((p, i) => (p.selected ? i : -1))
          .filter((i) => i >= 0);
      }
      const extracted = await extractPages(working, indices);
      const stem = `${sanitizeOutputStem(defaultEditedStem(sourcePath))}-extract`;
      const resolved = await probeCollision(sourcePath, outputDir, stem);
      setProgress(0.7);
      const result = await writeFileBytes(resolved.path, extracted);
      if (!result.ok) throw new Error(result.error ?? "Write failed");
      setProgress(1);
      setSummary(
        `Extracted ${indices.length} page(s) → ${basename(result.path)}`,
      );
      await revealInExplorer(result.path);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Extract failed");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const insertBlank = async () => {
    if (!bytes) return;
    setBusy(true);
    onError(null);
    try {
      let working = bytes;
      if (orderDirty) {
        working = await reorderPages(bytes, pages.map((p) => p.docIndex));
      }
      const next = await insertBlankPage(working, insertAt);
      applyBytes(next);
      setSummary(`Inserted blank page at position ${insertAt + 1}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Insert blank failed");
    } finally {
      setBusy(false);
    }
  };

  const insertFromPdf = async () => {
    if (!bytes) return;
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setBusy(true);
    onError(null);
    try {
      let working = bytes;
      if (orderDirty) {
        working = await reorderPages(bytes, pages.map((p) => p.docIndex));
      }
      const other = await readFileBytes(selected);
      const next = await insertPagesFromPdf(working, other, insertAt);
      applyBytes(next);
      setSummary(`Inserted pages from ${basename(selected)}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Insert from PDF failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!bytes || !sourcePath) return;
    if (!isValidOutputStem(outputStem)) {
      onError("Enter a valid output name.");
      return;
    }
    if (replaceOriginal) {
      const ok = window.confirm(
        "Replace original? The original will be moved to the Recycle Bin and the saved file renamed to the original name.",
      );
      if (!ok) return;
    }

    setBusy(true);
    setProgress(0.3);
    onError(null);
    try {
      let toSave = bytes;
      if (orderDirty) {
        toSave = await reorderPages(
          bytes,
          pages.map((p) => p.docIndex),
        );
      }

      const resolved = await probeCollision(
        sourcePath,
        outputDir,
        sanitizeOutputStem(outputStem),
      );
      setProgress(0.6);
      const result = await writeFileBytes(resolved.path, toSave);
      if (!result.ok) throw new Error(result.error ?? "Write failed");

      let finalPath = result.path;
      if (replaceOriginal) {
        await trashFile(sourcePath);
        await renameFileIfAbsent(result.path, sourcePath);
        finalPath = sourcePath;
      }

      if (orderDirty) {
        onBytesChange(toSave);
      }

      setProgress(1);
      setSummary(`Saved → ${basename(finalPath)}`);
      await revealInExplorer(finalPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  if (!sourcePath || !bytes) {
    return (
      <p className="text-sm text-zinc-500">
        Open a PDF first (use the intake above or switch from Open with a file
        loaded).
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !orderDirty}
          onClick={() => void applyReorder()}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40"
        >
          Apply reorder
        </button>
        <button
          type="button"
          disabled={busy || selectedDocIndices.length === 0}
          onClick={() => void rotateSelected(-90)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40"
        >
          Rotate left
        </button>
        <button
          type="button"
          disabled={busy || selectedDocIndices.length === 0}
          onClick={() => void rotateSelected(90)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40"
        >
          Rotate right
        </button>
        <button
          type="button"
          disabled={busy || selectedDocIndices.length === 0}
          onClick={() => void deleteSelected()}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40"
        >
          Delete
        </button>
        <button
          type="button"
          disabled={busy || selectedDocIndices.length === 0}
          onClick={() => void extractSelected()}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40"
        >
          Extract to new PDF
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-zinc-400">
          Insert at (1-based)
          <input
            type="number"
            min={1}
            max={pages.length + 1}
            value={insertAt + 1}
            onChange={(e) =>
              setInsertAt(Math.max(0, Number(e.target.value) - 1))
            }
            className="w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void insertBlank()}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 disabled:opacity-40"
        >
          Insert blank
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void insertFromPdf()}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 disabled:opacity-40"
        >
          Insert from PDF…
        </button>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {pages.map((page, listIndex) => (
          <div
            key={`${page.docIndex}-${listIndex}`}
            draggable
            onDragStart={() => setDragFrom(listIndex)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(listIndex)}
            className={`rounded-lg border p-1 cursor-grab active:cursor-grabbing ${
              page.selected
                ? "border-brand bg-brand/10"
                : "border-zinc-800 bg-zinc-900"
            }`}
          >
            <button
              type="button"
              className="w-full text-left"
              onClick={() => toggleSelect(listIndex)}
            >
              {page.thumb ? (
                <img
                  src={page.thumb}
                  alt={`Page ${listIndex + 1}`}
                  className="w-full rounded"
                />
              ) : (
                <div className="aspect-[3/4] bg-zinc-800 rounded flex items-center justify-center text-xs text-zinc-500">
                  {listIndex + 1}
                </div>
              )}
              <span className="block text-center text-xs text-zinc-400 mt-1">
                {listIndex + 1}
              </span>
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-4">
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
            Use source folder
          </button>
        )}
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={replaceOriginal}
            onChange={(e) => setReplaceOriginal(e.target.checked)}
            className="accent-[var(--color-brand)]"
          />
          Replace original (confirm on save)
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
        >
          Save PDF
        </button>
      </div>

      {busy && progress > 0 && (
        <ProgressBar value={progress} label="Working…" />
      )}
      {summary && <p className="text-sm text-zinc-300">{summary}</p>}
      <p className="text-xs text-zinc-500">
        Drag thumbnails to reorder, then click Apply reorder (or Save). Click a
        page to select it for rotate / delete / extract.
      </p>
    </div>
  );
}
