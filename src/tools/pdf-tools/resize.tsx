import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  clampScalePercent,
  defaultResizedStem,
  dirname,
  isValidOutputStem,
  pdfOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
  RESIZE_SCALE_PERCENT_DEFAULT,
  RESIZE_SCALE_PERCENT_MAX,
  RESIZE_SCALE_PERCENT_MIN,
  type ResizeAnchor,
} from "./logic";
import {
  pathsExist,
  renameFileIfAbsent,
  revealInExplorer,
  trashFile,
  writeFileBytes,
} from "./io";
import { pdfHasAnnotations, resizePages } from "./pdfOps";
import { loadPdfDocument, renderPageThumbnail } from "./pdfjs";

interface ResizeModeProps {
  sourcePath: string | null;
  bytes: Uint8Array | null;
  onError: (message: string | null) => void;
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
  const existsMap = await pathsExist(probe);
  return resolveStemAvoidingCollision(base, existsMap, (s) =>
    pdfOutputPath(sourcePath, outputDir, s),
  );
}

export function ResizeMode({ sourcePath, bytes, onError }: ResizeModeProps) {
  const [scalePercent, setScalePercent] = useState(RESIZE_SCALE_PERCENT_DEFAULT);
  const [scaleInput, setScaleInput] = useState(String(RESIZE_SCALE_PERCENT_DEFAULT));
  const [anchor, setAnchor] = useState<ResizeAnchor>("top-left");
  const [shrinkPage, setShrinkPage] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputStem, setOutputStem] = useState("");
  const [replaceOriginal, setReplaceOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [annotWarning, setAnnotWarning] = useState(false);

  const previewGen = useRef(0);
  const clampedScale = clampScalePercent(scalePercent);
  const scaleValid = clampedScale !== null;

  useEffect(() => {
    if (!sourcePath) return;
    setOutputStem(defaultResizedStem(sourcePath));
    setOutputDir(null);
    setReplaceOriginal(false);
    setSummary(null);
  }, [sourcePath]);

  useEffect(() => {
    if (!bytes) {
      setAnnotWarning(false);
      return;
    }
    let cancelled = false;
    void pdfHasAnnotations(bytes).then((has) => {
      if (!cancelled) setAnnotWarning(has);
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  useEffect(() => {
    if (!bytes || !scaleValid) {
      setPreviewUrl(null);
      return;
    }

    const gen = ++previewGen.current;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setPreviewBusy(true);
        let doc: Awaited<ReturnType<typeof loadPdfDocument>> | null = null;
        try {
          const resized = await resizePages(bytes, {
            scalePercent: clampedScale,
            anchor,
            shrinkPage,
          });
          if (cancelled || gen !== previewGen.current) return;
          doc = await loadPdfDocument(resized);
          if (cancelled || gen !== previewGen.current) return;
          const url = await renderPageThumbnail(doc, 0, 360);
          if (cancelled || gen !== previewGen.current) return;
          setPreviewUrl(url);
          onError(null);
        } catch (err) {
          if (cancelled || gen !== previewGen.current) return;
          setPreviewUrl(null);
          onError(
            err instanceof Error ? err.message : "Preview failed",
          );
        } finally {
          await doc?.cleanup();
          if (!cancelled && gen === previewGen.current) setPreviewBusy(false);
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bytes, clampedScale, scaleValid, anchor, shrinkPage, onError]);

  const applyScaleFromInput = (raw: string) => {
    setScaleInput(raw);
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const next = clampScalePercent(n);
    if (next !== null) setScalePercent(next);
  };

  const commitScaleInput = () => {
    const next = clampScalePercent(Number(scaleInput));
    if (next === null) {
      setScaleInput(String(scalePercent));
      return;
    }
    setScalePercent(next);
    setScaleInput(String(next));
  };

  const save = async () => {
    if (!bytes || !sourcePath) return;
    if (!scaleValid || clampedScale === null) {
      onError(
        `Scale must be between ${RESIZE_SCALE_PERCENT_MIN} and ${RESIZE_SCALE_PERCENT_MAX}.`,
      );
      return;
    }
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
      const resized = await resizePages(bytes, {
        scalePercent: clampedScale,
        anchor,
        shrinkPage,
      });
      const resolved = await probeCollision(
        sourcePath,
        outputDir,
        sanitizeOutputStem(outputStem),
      );
      setProgress(0.7);
      const result = await writeFileBytes(resolved.path, resized);
      if (!result.ok) throw new Error(result.error ?? "Write failed");

      let finalPath = result.path;
      if (replaceOriginal) {
        await trashFile(sourcePath);
        await renameFileIfAbsent(result.path, sourcePath);
        finalPath = sourcePath;
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
        Open a PDF first (use the intake above).
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {annotWarning && (
        <p className="text-sm text-amber-400/90">
          This PDF has annotations or form fields. Resize embeds page content
          only — annotations may be dropped in the output.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm text-zinc-400 min-w-[12rem]">
          Scale ({RESIZE_SCALE_PERCENT_MIN}–{RESIZE_SCALE_PERCENT_MAX}%)
          <input
            type="range"
            min={RESIZE_SCALE_PERCENT_MIN}
            max={RESIZE_SCALE_PERCENT_MAX}
            step={1}
            value={scalePercent}
            onChange={(e) => {
              const n = Number(e.target.value);
              setScalePercent(n);
              setScaleInput(String(n));
            }}
            className="accent-[var(--color-brand)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-400">
          Percent
          <input
            type="number"
            min={RESIZE_SCALE_PERCENT_MIN}
            max={RESIZE_SCALE_PERCENT_MAX}
            value={scaleInput}
            onChange={(e) => applyScaleFromInput(e.target.value)}
            onBlur={commitScaleInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitScaleInput();
            }}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100"
          />
        </label>

        <fieldset
          disabled={shrinkPage}
          className="flex flex-col gap-1 text-sm text-zinc-400 disabled:opacity-40"
        >
          <legend className="mb-1">Position</legend>
          <div className="flex gap-3">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="resize-anchor"
                checked={anchor === "top-left"}
                onChange={() => setAnchor("top-left")}
                className="accent-[var(--color-brand)]"
              />
              Top-left
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="resize-anchor"
                checked={anchor === "center"}
                onChange={() => setAnchor("center")}
                className="accent-[var(--color-brand)]"
              />
              Center
            </label>
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-zinc-400 pb-1.5">
          <input
            type="checkbox"
            checked={shrinkPage}
            onChange={(e) => setShrinkPage(e.target.checked)}
            className="accent-[var(--color-brand)]"
          />
          Shrink page to content
        </label>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 max-w-md">
        <p className="text-xs text-zinc-500 mb-2">
          Preview (page 1){previewBusy ? "…" : ""}
        </p>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Resized page preview"
            className="max-w-full rounded border border-zinc-800 bg-white"
          />
        ) : (
          <div className="aspect-[3/4] max-h-64 bg-zinc-800 rounded flex items-center justify-center text-xs text-zinc-500">
            {scaleValid ? "Generating preview…" : "Enter a valid scale"}
          </div>
        )}
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
        <p className="text-xs font-mono text-zinc-500 truncate max-w-xl self-center">
          {outputDir ?? dirname(sourcePath)}
        </p>
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
          disabled={busy || !scaleValid}
          onClick={() => void save()}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
        >
          Save PDF
        </button>
      </div>

      {busy && progress > 0 && (
        <ProgressBar value={progress} label="Saving…" />
      )}
      {summary && <p className="text-sm text-zinc-300">{summary}</p>}
      <p className="text-xs text-zinc-500">
        Scales page content for smaller physical prints (e.g. shipping labels).
        Default keeps the original page size so you can print at 100% and cut
        out the label.
      </p>
    </div>
  );
}
