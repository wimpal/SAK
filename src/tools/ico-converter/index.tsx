import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import {
  basename,
  buildOutputPreview,
  centeredSquareCrop,
  DEFAULT_SIZES,
  dirname,
  ICO_SIZES,
  isImagePath,
  outputPath,
  type CropRect,
  type IcoSize,
  type OutputPreviewRow,
} from "./logic";
import { SquareCropEditor } from "./SquareCropEditor";

interface ExportIcoResult {
  size: number;
  path: string;
  ok: boolean;
  error?: string;
}

interface ImagePreview {
  width: number;
  height: number;
  dataUrl: string;
}

const imageFilters = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
];

export default function IcoConverterTool() {
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [selectedSizes, setSelectedSizes] = useState<Set<IcoSize>>(
    () => new Set(DEFAULT_SIZES),
  );
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputPreviewRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const loadImage = useCallback(async (path: string) => {
    if (!isImagePath(path)) {
      setLoadError(
        "Please choose a supported image file (PNG, JPEG, WebP, BMP, GIF).",
      );
      return;
    }

    setLoadError(null);
    setSummary(null);
    setLoading(true);
    setSourcePath(path);
    setOutputDir(null);
    setImageSrc(null);
    setNaturalSize(null);
    setCrop(null);

    try {
      const result = await invoke<ImagePreview>("load_image_preview", { path });
      setImageSrc(result.dataUrl);
      setNaturalSize({ width: result.width, height: result.height });
      setCrop(centeredSquareCrop(result.width, result.height));
    } catch (err) {
      setSourcePath(null);
      setImageSrc(null);
      setNaturalSize(null);
      setCrop(null);
      setLoadError(
        typeof err === "string" ? err : "Could not load the selected image.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePick = useCallback(
    (paths: string[]) => {
      const path = paths[0];
      if (path) void loadImage(path);
    },
    [loadImage],
  );

  const handleDrop = useCallback(
    (paths: string[]) => {
      const image = paths.find(isImagePath);
      if (image) {
        void loadImage(image);
      } else {
        setLoadError(
          "Drop a supported image file (PNG, JPEG, WebP, BMP, GIF).",
        );
      }
    },
    [loadImage],
  );

  useEffect(() => {
    if (!sourcePath || selectedSizes.size === 0) {
      setPreview([]);
      return;
    }

    let cancelled = false;
    const sizes = ICO_SIZES.filter((s) => selectedSizes.has(s));
    const paths = sizes.map((size) => outputPath(sourcePath, outputDir, size));

    async function refresh() {
      const exists =
        paths.length > 0
          ? await invoke<boolean[]>("paths_exist", { paths })
          : [];
      if (cancelled) return;

      const existsMap = new Map<string, boolean>();
      paths.forEach((path, i) => existsMap.set(path, exists[i]));
      setPreview(buildOutputPreview(sourcePath!, outputDir, sizes, existsMap));
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [sourcePath, outputDir, selectedSizes]);

  function toggleSize(size: IcoSize) {
    setSelectedSizes((prev) => {
      const next = new Set(prev);
      if (next.has(size)) next.delete(size);
      else next.add(size);
      return next;
    });
    setSummary(null);
  }

  async function chooseOutputFolder() {
    const selected = await open({ directory: true });
    if (typeof selected === "string") {
      setOutputDir(selected);
      setSummary(null);
    }
  }

  function clearImage() {
    setSourcePath(null);
    setImageSrc(null);
    setNaturalSize(null);
    setCrop(null);
    setOutputDir(null);
    setPreview([]);
    setLoadError(null);
    setSummary(null);
  }

  async function exportIcons() {
    if (!sourcePath || !crop || selectedSizes.size === 0) return;

    const sizes = ICO_SIZES.filter((s) => selectedSizes.has(s));
    setExporting(true);
    setSummary(null);
    try {
      const results = await invoke<ExportIcoResult[]>("export_ico_files", {
        sourcePath,
        outputDir,
        crop: {
          x: Math.round(crop.x),
          y: Math.round(crop.y),
          size: Math.round(crop.size),
        },
        sizes,
      });

      const created = results.filter((r) => r.ok).length;
      const skipped = results.filter(
        (r) => !r.ok && r.error === "target already exists",
      ).length;
      const failed = results.filter(
        (r) => !r.ok && r.error !== "target already exists",
      ).length;

      const parts = [`${created} created`];
      if (skipped > 0) parts.push(`${skipped} skipped (collision)`);
      if (failed > 0) {
        const firstError = results.find(
          (r) => !r.ok && r.error !== "target already exists",
        )?.error;
        parts.push(
          firstError
            ? `${failed} failed (${firstError})`
            : `${failed} failed`,
        );
      }
      setSummary(`${parts.join(", ")}.`);

      const paths = sizes.map((size) => outputPath(sourcePath, outputDir, size));
      const exists = await invoke<boolean[]>("paths_exist", { paths });
      const existsMap = new Map<string, boolean>();
      paths.forEach((path, i) => existsMap.set(path, exists[i]));
      setPreview(buildOutputPreview(sourcePath, outputDir, sizes, existsMap));
    } catch (err) {
      setSummary(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Export failed.",
      );
    } finally {
      setExporting(false);
    }
  }

  const readyCount = preview.filter((r) => r.status === "ready").length;
  const canExport =
    sourcePath !== null &&
    crop !== null &&
    selectedSizes.size > 0 &&
    readyCount > 0 &&
    !exporting;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilePickerButton
            label="Choose image"
            filters={imageFilters}
            onPick={handlePick}
          />
          {sourcePath && (
            <button
              onClick={clearImage}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <DropZone onDrop={handleDrop}>Drop an image here</DropZone>

        {loading && (
          <p className="text-sm text-zinc-500">Loading image…</p>
        )}

        {loadError && (
          <p className="text-sm text-brand-soft">{loadError}</p>
        )}

        {sourcePath && (
          <p className="text-xs font-mono text-zinc-500 truncate" title={sourcePath}>
            {basename(sourcePath)}
            {naturalSize && (
              <span className="text-zinc-600">
                {" "}
                — {naturalSize.width}×{naturalSize.height}
              </span>
            )}
          </p>
        )}
      </section>

      {imageSrc && naturalSize && crop && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-300">Crop</h2>
          <SquareCropEditor
            imageSrc={imageSrc}
            naturalWidth={naturalSize.width}
            naturalHeight={naturalSize.height}
            crop={crop}
            onCropChange={setCrop}
          />
        </section>
      )}

      {sourcePath && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-300">Icon sizes</h2>
            <div className="flex flex-wrap gap-2">
              {ICO_SIZES.map((size) => {
                const active = selectedSizes.has(size);
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => toggleSize(size)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-mono transition-colors ${
                      active
                        ? "bg-brand/20 text-brand-soft border border-brand/50"
                        : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500"
                    }`}
                  >
                    {size}×{size}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-300">Output folder</h2>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={chooseOutputFolder}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:border-zinc-500 transition-colors"
              >
                Choose folder
              </button>
              <p className="text-xs font-mono text-zinc-500 truncate max-w-xl">
                {outputDir ?? dirname(sourcePath)}
              </p>
              {outputDir && (
                <button
                  type="button"
                  onClick={() => {
                    setOutputDir(null);
                    setSummary(null);
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Reset to source folder
                </button>
              )}
            </div>
          </section>

          {preview.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">
                Output preview — {readyCount} of {preview.length} ready
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Size</th>
                      <th className="px-4 py-2 font-medium">File</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr
                        key={row.size}
                        className="border-t border-zinc-800 even:bg-zinc-900/40"
                      >
                        <td className="px-4 py-2 font-mono text-xs text-zinc-300">
                          {row.size}×{row.size}
                        </td>
                        <td
                          className="px-4 py-2 font-mono text-xs text-zinc-400 truncate max-w-md"
                          title={row.path}
                        >
                          {basename(row.path)}
                        </td>
                        <td
                          className={`px-4 py-2 text-xs ${
                            row.status === "ready"
                              ? "text-zinc-400"
                              : "text-brand-soft"
                          }`}
                        >
                          {row.status === "ready" ? "Ready" : "Already exists"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="flex flex-wrap items-center gap-4">
            <button
              onClick={exportIcons}
              disabled={!canExport}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            >
              {exporting ? "Exporting…" : `Export (${readyCount})`}
            </button>
            {summary && <p className="text-sm text-zinc-400">{summary}</p>}
          </section>
        </>
      )}
    </div>
  );
}
