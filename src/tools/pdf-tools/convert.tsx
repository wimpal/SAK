import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  defaultImagesToPdfStem,
  defaultPagesFolderName,
  fileExtension,
  fileStem,
  imageOutputPath,
  isValidOutputStem,
  moveIndex,
  pagesOutputDir,
  parsePageRanges,
  pdfOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
  type ConvertDirection,
  type ImageFormat,
  type PageFitMode,
  IMAGE_FORMATS,
} from "./logic";
import {
  ensureDir,
  pathsExist,
  readFileBytes,
  revealInExplorer,
  writeFileBytes,
} from "./io";
import { imagesToPdf } from "./pdfOps";
import { loadPdfDocument, renderPageImageBytes } from "./pdfjs";

interface ConvertModeProps {
  pdfPath: string | null;
  pdfBytes: Uint8Array | null;
  imagePaths: string[];
  direction: ConvertDirection;
  onDirectionChange: (d: ConvertDirection) => void;
  onError: (message: string | null) => void;
}

interface ImagePreview {
  width: number;
  height: number;
  dataUrl: string;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function imageBytesForPdf(path: string): Promise<{
  bytes: Uint8Array;
  mimeOrExt: string;
}> {
  const ext = fileExtension(path) ?? "";
  if (ext === "png" || ext === "jpg" || ext === "jpeg") {
    return { bytes: await readFileBytes(path), mimeOrExt: ext };
  }
  // pdf-lib only embeds PNG/JPEG — convert via Rust preview
  const preview = await invoke<ImagePreview>("load_image_preview", { path });
  return { bytes: dataUrlToBytes(preview.dataUrl), mimeOrExt: "png" };
}

export function ConvertMode({
  pdfPath,
  pdfBytes,
  imagePaths,
  direction,
  onDirectionChange,
  onError,
}: ConvertModeProps) {
  const [rangeInput, setRangeInput] = useState("all");
  const [dpi, setDpi] = useState(150);
  const [format, setFormat] = useState<ImageFormat>("png");
  const [pageCount, setPageCount] = useState(0);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [folderStem, setFolderStem] = useState("");
  const [pdfStem, setPdfStem] = useState("");
  const [fitMode, setFitMode] = useState<PageFitMode>("fit");
  const [uniform, setUniform] = useState(true);
  const [orderedImages, setOrderedImages] = useState<string[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    setOrderedImages(imagePaths);
  }, [imagePaths]);

  useEffect(() => {
    if (!pdfPath || !pdfBytes) {
      setPageCount(0);
      setFolderStem("");
      return;
    }
    setFolderStem(sanitizeOutputStem(defaultPagesFolderName(pdfPath)));
    setRangeInput("all");
    setOutputDir(null);
    setSummary(null);
    void loadPdfDocument(pdfBytes)
      .then((doc) => {
        setPageCount(doc.numPages);
        return doc.cleanup();
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : "Failed to read PDF"),
      );
  }, [pdfPath, pdfBytes, onError]);

  useEffect(() => {
    if (imagePaths.length > 0) {
      setPdfStem(sanitizeOutputStem(defaultImagesToPdfStem(imagePaths[0])));
      setOutputDir(null);
      setSummary(null);
    } else {
      setPdfStem("");
    }
  }, [imagePaths]);

  const runPdfToImages = useCallback(async () => {
    if (!pdfPath || !pdfBytes || pageCount === 0) return;
    const parsed = parsePageRanges(rangeInput, pageCount);
    if ("error" in parsed) {
      onError(parsed.error);
      return;
    }
    if (!isValidOutputStem(folderStem)) {
      onError("Enter a valid folder name.");
      return;
    }

    setBusy(true);
    setProgress(0);
    onError(null);
    try {
      const baseFolder = sanitizeOutputStem(folderStem);
      const parent = outputDir;
      const probeDirs: string[] = [];
      for (let n = 0; n < 40; n++) {
        const name = n === 0 ? baseFolder : `${baseFolder}-${n + 1}`;
        probeDirs.push(pagesOutputDir(pdfPath, parent, name));
      }
      const existsMap = await pathsExist(probeDirs);
      const resolvedDir = resolveStemAvoidingCollision(
        baseFolder,
        existsMap,
        (s) => pagesOutputDir(pdfPath, parent, s),
      );

      await ensureDir(resolvedDir.path);
      const doc = await loadPdfDocument(pdfBytes);
      const stem = fileStem(pdfPath);
      let written = 0;

      for (let i = 0; i < parsed.indices.length; i++) {
        const pageIndex = parsed.indices[i];
        const bytes = await renderPageImageBytes(
          doc,
          pageIndex,
          dpi,
          format,
        );
        const outPath = imageOutputPath(
          resolvedDir.path,
          stem,
          pageIndex + 1,
          format,
        );
        // bump if somehow exists
        let target = outPath;
        const exists = await pathsExist([target]);
        if (exists.get(target)) {
          const bumped = resolveStemAvoidingCollision(
            `${stem}-page-${String(pageIndex + 1).padStart(3, "0")}`,
            await pathsExist(
              Array.from({ length: 20 }, (_, n) =>
                imageOutputPath(
                  resolvedDir.path,
                  n === 0
                    ? `${stem}-page-${String(pageIndex + 1).padStart(3, "0")}`
                    : `${stem}-page-${String(pageIndex + 1).padStart(3, "0")}-${n + 1}`,
                  pageIndex + 1,
                  format,
                ),
              ),
            ),
            (s) =>
              imageOutputPath(resolvedDir.path, s, pageIndex + 1, format),
          );
          target = bumped.path;
        }

        const result = await writeFileBytes(target, bytes);
        if (!result.ok) throw new Error(result.error ?? "Write failed");
        written += 1;
        setProgress((i + 1) / parsed.indices.length);
      }

      await doc.cleanup();
      setSummary(
        `Wrote ${written} image(s) to ${basename(resolvedDir.path)}/`,
      );
      const first = imageOutputPath(
        resolvedDir.path,
        stem,
        parsed.indices[0] + 1,
        format,
      );
      await revealInExplorer(first).catch(() => undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : "PDF → images failed");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }, [
    pdfPath,
    pdfBytes,
    pageCount,
    rangeInput,
    folderStem,
    outputDir,
    dpi,
    format,
    onError,
  ]);

  const runImagesToPdf = useCallback(async () => {
    if (orderedImages.length === 0) return;
    if (!isValidOutputStem(pdfStem)) {
      onError("Enter a valid output name.");
      return;
    }

    setBusy(true);
    setProgress(0);
    onError(null);
    try {
      const inputs: { bytes: Uint8Array; mimeOrExt: string }[] = [];
      for (let i = 0; i < orderedImages.length; i++) {
        inputs.push(await imageBytesForPdf(orderedImages[i]));
        setProgress(((i + 1) / orderedImages.length) * 0.6);
      }

      const pdfBytesOut = await imagesToPdf(inputs, fitMode, uniform);
      setProgress(0.75);

      const sourcePath = orderedImages[0];
      const base = sanitizeOutputStem(pdfStem);
      const probe = Array.from({ length: 40 }, (_, n) =>
        pdfOutputPath(
          sourcePath,
          outputDir,
          n === 0 ? base : `${base}-${n + 1}`,
        ),
      );
      const existsMap = await pathsExist(probe);
      const resolved = resolveStemAvoidingCollision(base, existsMap, (s) =>
        pdfOutputPath(sourcePath, outputDir, s),
      );

      const result = await writeFileBytes(resolved.path, pdfBytesOut);
      if (!result.ok) throw new Error(result.error ?? "Write failed");
      setProgress(1);
      setSummary(`Created ${basename(result.path)}`);
      await revealInExplorer(result.path);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Images → PDF failed");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }, [orderedImages, pdfStem, outputDir, fitMode, uniform, onError]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(
          [
            ["pdf-to-images", "PDF → images"],
            ["images-to-pdf", "Images → PDF"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onDirectionChange(id)}
            className={`rounded-lg px-3 py-1.5 text-sm border transition-colors ${
              direction === id
                ? "border-brand bg-brand/15 text-brand-soft"
                : "border-zinc-700 bg-zinc-800 hover:border-zinc-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {direction === "pdf-to-images" && (
        <>
          {!pdfPath || !pdfBytes ? (
            <p className="text-sm text-zinc-500">
              Load a PDF above to export pages as images.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                {basename(pdfPath)} · {pageCount} pages
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex flex-col gap-1 text-zinc-400">
                  Pages
                  <input
                    value={rangeInput}
                    onChange={(e) => setRangeInput(e.target.value)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 w-40"
                    placeholder="all or 1-3, 7"
                  />
                </label>
                <label className="flex flex-col gap-1 text-zinc-400">
                  DPI
                  <input
                    type="number"
                    min={72}
                    max={600}
                    value={dpi}
                    onChange={(e) => setDpi(Number(e.target.value) || 150)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 w-24"
                  />
                </label>
                <label className="flex flex-col gap-1 text-zinc-400">
                  Format
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ImageFormat)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  >
                    {IMAGE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-zinc-400">
                  Folder name
                  <input
                    value={folderStem}
                    onChange={(e) => setFolderStem(e.target.value)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 min-w-[12rem]"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500"
                  onClick={async () => {
                    const dir = await open({ directory: true, multiple: false });
                    if (typeof dir === "string") setOutputDir(dir);
                  }}
                >
                  {outputDir ? "Change parent folder…" : "Parent folder…"}
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
                  disabled={busy}
                  onClick={() => void runPdfToImages()}
                  className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
                >
                  Export images
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {direction === "images-to-pdf" && (
        <>
          {orderedImages.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Pick or drop images above to build a PDF.
            </p>
          ) : (
            <div className="space-y-3">
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {orderedImages.map((path, i) => (
                  <li
                    key={path}
                    draggable
                    onDragStart={() => setDragFrom(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragFrom === null) return;
                      setOrderedImages((prev) =>
                        moveIndex(prev, dragFrom, i),
                      );
                      setDragFrom(null);
                    }}
                    className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm cursor-grab"
                  >
                    <span className="text-zinc-500 w-5">{i + 1}</span>
                    <span className="truncate">{basename(path)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex flex-col gap-1 text-zinc-400">
                  Page fit
                  <select
                    value={fitMode}
                    onChange={(e) =>
                      setFitMode(e.target.value as PageFitMode)
                    }
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  >
                    <option value="fit">Fit (letter)</option>
                    <option value="fill">Fill (letter)</option>
                    <option value="original">Original size</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-zinc-400 self-end pb-1">
                  <input
                    type="checkbox"
                    checked={uniform}
                    onChange={(e) => setUniform(e.target.checked)}
                    className="accent-[var(--color-brand)]"
                  />
                  Uniform page size
                </label>
                <label className="flex flex-col gap-1 text-zinc-400">
                  Output name
                  <input
                    value={pdfStem}
                    onChange={(e) => setPdfStem(e.target.value)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 min-w-[12rem]"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3 items-center">
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
                    Next to first image
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runImagesToPdf()}
                  className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-soft disabled:opacity-40"
                >
                  Create PDF
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {busy && (
        <ProgressBar
          value={progress}
          label={
            direction === "pdf-to-images" ? "Exporting…" : "Building PDF…"
          }
        />
      )}
      {summary && <p className="text-sm text-zinc-300">{summary}</p>}
    </div>
  );
}
