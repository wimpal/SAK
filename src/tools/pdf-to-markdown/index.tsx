import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  defaultMarkdownStem,
  isPdfPath,
  isValidOutputStem,
  makeJobId,
  markdownOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";
import {
  cancelEbookConvertJob,
  convertPdfToMarkdown,
  ebookConvertVersion,
  pathsExist,
  revealInExplorer,
} from "./io";

const pdfFilters = [{ name: "PDF", extensions: ["pdf"] }];

interface EbookConvertProgressPayload {
  jobId: string;
  ratio: number;
}

export default function PdfToMarkdownTool() {
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputStem, setOutputStem] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [resolvedOutput, setResolvedOutput] = useState<string | null>(null);
  const [calibreVersion, setCalibreVersion] = useState<string | null>(null);
  const [calibreError, setCalibreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Converting…");
  const activeJobId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ebookConvertVersion()
      .then((version) => {
        if (!cancelled) {
          setCalibreVersion(version);
          setCalibreError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCalibreVersion(null);
          setCalibreError(
            err instanceof Error
              ? err.message
              : "Calibre runtime is not available. Run node scripts/setup-calibre.mjs",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectPdf = useCallback((path: string) => {
    if (!isPdfPath(path)) {
      setError("Please choose a .pdf file.");
      return;
    }
    const stem = sanitizeOutputStem(defaultMarkdownStem(path));
    setSourcePath(path);
    setOutputDir(null);
    setOutputStem(stem);
    setDocTitle(stem);
    setError(null);
    setSummary(null);
  }, []);

  const handlePick = useCallback(
    (paths: string[]) => {
      const path = paths[0];
      if (path) selectPdf(path);
    },
    [selectPdf],
  );

  const handleDrop = useCallback(
    (paths: string[]) => {
      const pdf = paths.find(isPdfPath);
      if (pdf) {
        selectPdf(pdf);
      } else {
        setError("Drop a .pdf file.");
      }
    },
    [selectPdf],
  );

  useEffect(() => {
    if (!sourcePath || !isValidOutputStem(outputStem)) {
      setResolvedOutput(null);
      return;
    }

    let cancelled = false;
    const stem = sanitizeOutputStem(outputStem);
    const probe = Array.from({ length: 40 }, (_, n) =>
      markdownOutputPath(
        sourcePath,
        outputDir,
        n === 0 ? stem : `${stem}-${n + 1}`,
      ),
    );

    void pathsExist(probe).then((existsMap) => {
      if (cancelled) return;
      const resolved = resolveStemAvoidingCollision(stem, existsMap, (s) =>
        markdownOutputPath(sourcePath, outputDir, s),
      );
      setResolvedOutput(resolved.path);
    });

    return () => {
      cancelled = true;
    };
  }, [sourcePath, outputDir, outputStem]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen<EbookConvertProgressPayload>(
      "ebook-convert-progress",
      (event) => {
        if (event.payload.jobId !== activeJobId.current) return;
        setProgress(event.payload.ratio);
        if (event.payload.ratio > 0) {
          setProgressLabel(
            `Converting… ${Math.round(event.payload.ratio * 100)}%`,
          );
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  async function handleCancel() {
    const jobId = activeJobId.current;
    if (!jobId) return;
    try {
      await cancelEbookConvertJob(jobId);
    } catch {
      /* job may have finished */
    }
  }

  async function handleConvert() {
    if (!sourcePath || !resolvedOutput) return;
    if (!isValidOutputStem(outputStem)) {
      setError("Enter a valid output name.");
      return;
    }
    if (calibreError) {
      setError(calibreError);
      return;
    }

    const jobId = makeJobId();
    activeJobId.current = jobId;
    setBusy(true);
    setProgress(0);
    setProgressLabel("Converting…");
    setError(null);
    setSummary(null);

    try {
      const title = docTitle.trim();
      const result = await convertPdfToMarkdown({
        jobId,
        sourcePath,
        outputPath: resolvedOutput,
        title: title.length > 0 ? title : null,
      });

      if (!result.ok) {
        throw new Error(result.error ?? "Conversion failed");
      }

      setSummary(`Created ${basename(result.path)}`);
      await revealInExplorer(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Conversion failed");
    } finally {
      activeJobId.current = null;
      setBusy(false);
      setProgress(0);
      setProgressLabel("Converting…");
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Convert a PDF into Markdown using the bundled Calibre engine. Quality
        depends on the PDF structure — this works best for text-heavy documents.
        Scanned PDFs (no OCR) and password-protected files are not supported.
      </p>

      {calibreError ? (
        <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {calibreError}
        </p>
      ) : calibreVersion ? (
        <p className="text-xs text-zinc-600">Calibre {calibreVersion}</p>
      ) : (
        <p className="text-xs text-zinc-600">Checking Calibre runtime…</p>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <FilePickerButton
            label="Choose PDF…"
            filters={pdfFilters}
            onPick={handlePick}
          />
          {sourcePath && (
            <button
              type="button"
              onClick={() => {
                setSourcePath(null);
                setOutputStem("");
                setDocTitle("");
                setResolvedOutput(null);
                setSummary(null);
                setError(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <DropZone onDrop={handleDrop}>Drop a PDF here</DropZone>

        {sourcePath && (
          <p
            className="text-sm text-zinc-300 font-mono truncate"
            title={sourcePath}
          >
            {basename(sourcePath)}
          </p>
        )}
      </section>

      {sourcePath && (
        <section className="space-y-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex flex-col gap-1 text-zinc-400 min-w-[12rem]">
              Output name
              <input
                value={outputStem}
                onChange={(e) => setOutputStem(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
              />
            </label>
            <label className="flex flex-col gap-1 text-zinc-400 min-w-[12rem]">
              Document title
              <input
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
              />
            </label>
          </div>

          {resolvedOutput && (
            <p
              className="text-xs text-zinc-500 font-mono truncate"
              title={resolvedOutput}
            >
              Output: {resolvedOutput}
            </p>
          )}

          <div className="flex flex-wrap gap-3 items-center">
            <button
              type="button"
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500"
              onClick={async () => {
                const dir = await open({ directory: true, multiple: false });
                if (typeof dir === "string") setOutputDir(dir);
              }}
            >
              {outputDir ? "Change output folder…" : "Output folder…"}
            </button>
            {outputDir && (
              <button
                type="button"
                className="text-sm text-zinc-500 hover:text-zinc-300"
                onClick={() => setOutputDir(null)}
              >
                Next to PDF
              </button>
            )}
            <button
              type="button"
              disabled={busy || !resolvedOutput || !!calibreError}
              onClick={() => void handleConvert()}
              className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
            >
              Convert to Markdown
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => void handleCancel()}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-400 hover:border-zinc-500"
              >
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {busy && <ProgressBar value={progress} label={progressLabel} />}
      {error && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {summary && <p className="text-sm text-zinc-300">{summary}</p>}
    </div>
  );
}
