import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import { CropEditor } from "./CropEditor";
import {
  ASPECT_RATIOS,
  basename,
  centeredCropWithAspect,
  centeredCropWithSize,
  centeredDefaultCrop,
  defaultOutputName,
  dirname,
  FORMAT_EXT,
  getAspectValue,
  isImagePath,
  isValidOutputName,
  outputPath,
  OUTPUT_FORMATS,
  sanitizeOutputName,
  SIZE_PRESETS,
  type AspectRatioId,
  type CropRect,
  type OutputFormat,
  type SizePresetId,
} from "./logic";

interface ImagePreview {
  width: number;
  height: number;
  dataUrl: string;
}

interface ExportCroppedResult {
  path: string;
  ok: boolean;
  error?: string;
}

const imageFilters = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
];

const FORMAT_LABELS: Record<OutputFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
};

export default function ImageCropperTool() {
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioId>("free");
  const [activeSize, setActiveSize] = useState<SizePresetId | null>(null);
  const [format, setFormat] = useState<OutputFormat>("png");
  const [outputName, setOutputName] = useState("");
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputExists, setOutputExists] = useState(false);
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
    setOutputName("");
    setImageSrc(null);
    setNaturalSize(null);
    setCrop(null);
    setAspectRatio("free");
    setActiveSize(null);

    try {
      const result = await invoke<ImagePreview>("load_image_preview", { path });
      setImageSrc(result.dataUrl);
      setNaturalSize({ width: result.width, height: result.height });
      setCrop(centeredDefaultCrop(result.width, result.height));
      setOutputName(defaultOutputName(path));
    } catch (err) {
      setSourcePath(null);
      setImageSrc(null);
      setNaturalSize(null);
      setCrop(null);
      setAspectRatio("free");
      setActiveSize(null);
      setOutputName("");
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
    if (!sourcePath) {
      setOutputExists(false);
      return;
    }

    let cancelled = false;
    const path = outputPath(sourcePath, outputDir, format, outputName);

    async function refresh() {
      const exists = await invoke<boolean[]>("paths_exist", { paths: [path] });
      if (!cancelled) setOutputExists(exists[0]);
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [sourcePath, outputDir, format, outputName]);

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
    setAspectRatio("free");
    setActiveSize(null);
    setOutputDir(null);
    setOutputName("");
    setLoadError(null);
    setSummary(null);
  }

  function selectAspectRatio(id: AspectRatioId) {
    if (!naturalSize) return;
    setAspectRatio(id);
    setActiveSize(null);
    setSummary(null);

    const aspect = getAspectValue(id);
    if (aspect === null) {
      // Freeform: leave current crop as-is.
      return;
    }
    setCrop(
      centeredCropWithAspect(naturalSize.width, naturalSize.height, aspect),
    );
  }

  function selectSizePreset(id: SizePresetId) {
    if (!naturalSize) return;
    const preset = SIZE_PRESETS.find((p) => p.id === id);
    if (!preset) return;

    setActiveSize(id);
    setAspectRatio("free");
    setCrop(
      centeredCropWithSize(
        naturalSize.width,
        naturalSize.height,
        preset.width,
        preset.height,
      ),
    );
    setSummary(null);
  }

  async function exportCrop() {
    if (!sourcePath || !crop || !isValidOutputName(outputName)) return;

    const stem = sanitizeOutputName(outputName);
    setExporting(true);
    setSummary(null);
    try {
      const result = await invoke<ExportCroppedResult>("export_cropped_image", {
        sourcePath,
        outputDir,
        crop: {
          x: Math.round(crop.x),
          y: Math.round(crop.y),
          width: Math.round(crop.width),
          height: Math.round(crop.height),
        },
        format,
        outputName: stem,
      });

      if (result.ok) {
        setSummary(`Saved to ${basename(result.path)}.`);
      } else if (result.error === "target already exists") {
        setSummary("Skipped — file already exists.");
      } else {
        setSummary(result.error ?? "Export failed.");
      }

      const path = outputPath(sourcePath, outputDir, format, stem);
      const exists = await invoke<boolean[]>("paths_exist", { paths: [path] });
      setOutputExists(exists[0]);
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

  const nameValid = isValidOutputName(outputName);
  const outputFile =
    sourcePath !== null && nameValid
      ? outputPath(sourcePath, outputDir, format, outputName)
      : null;
  const canExport =
    sourcePath !== null &&
    crop !== null &&
    nameValid &&
    !outputExists &&
    !exporting;
  const aspectLock = getAspectValue(aspectRatio);

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

        {loading && <p className="text-sm text-zinc-500">Loading image…</p>}

        {loadError && <p className="text-sm text-brand-soft">{loadError}</p>}

        {sourcePath && (
          <p
            className="text-xs font-mono text-zinc-500 truncate"
            title={sourcePath}
          >
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
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Crop</h2>

          <div className="space-y-2">
            <p className="text-xs text-zinc-500">Aspect ratio</p>
            <div className="flex flex-wrap gap-2">
              {ASPECT_RATIOS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => selectAspectRatio(option.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-mono transition-colors ${
                    aspectRatio === option.id
                      ? "bg-brand/20 text-brand-soft border border-brand/50"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-zinc-500">Preset size</p>
            <div className="flex flex-wrap gap-2">
              {SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectSizePreset(preset.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-mono transition-colors ${
                    activeSize === preset.id
                      ? "bg-brand/20 text-brand-soft border border-brand/50"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <CropEditor
            imageSrc={imageSrc}
            naturalWidth={naturalSize.width}
            naturalHeight={naturalSize.height}
            crop={crop}
            aspectLock={aspectLock}
            onCropChange={(next) => {
              setCrop(next);
              if (activeSize !== null) setActiveSize(null);
            }}
          />
          <p className="text-xs font-mono text-zinc-600">
            {Math.round(crop.width)}×{Math.round(crop.height)} px
          </p>
        </section>
      )}

      {sourcePath && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-300">Output format</h2>
            <div className="flex flex-wrap gap-2">
              {OUTPUT_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setFormat(f);
                    setSummary(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    format === f
                      ? "bg-brand/20 text-brand-soft border border-brand/50"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  {FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-300">Output name</h2>
            <label className="flex items-center gap-2">
              <input
                type="text"
                value={outputName}
                onChange={(e) => {
                  setOutputName(e.target.value);
                  setSummary(null);
                }}
                placeholder="cropped"
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 text-sm font-mono text-zinc-500">
                .{FORMAT_EXT[format]}
              </span>
            </label>
            {outputName.trim() && !nameValid && (
              <p className="text-xs text-brand-soft">
                Enter a valid file name (no path characters).
              </p>
            )}
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

          {outputFile && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-zinc-300">
                Output preview
              </h2>
              <div className="rounded-xl border border-zinc-800 px-4 py-3 text-sm">
                <p
                  className="font-mono text-xs text-zinc-400 truncate"
                  title={outputFile}
                >
                  {basename(outputFile)}
                </p>
                <p
                  className={`mt-1 text-xs ${
                    outputExists ? "text-brand-soft" : "text-zinc-500"
                  }`}
                >
                  {outputExists ? "Already exists" : "Ready"}
                </p>
              </div>
            </section>
          )}

          <section className="flex flex-wrap items-center gap-4">
            <button
              onClick={exportCrop}
              disabled={!canExport}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            >
              {exporting ? "Exporting…" : "Export"}
            </button>
            {summary && <p className="text-sm text-zinc-400">{summary}</p>}
          </section>
        </>
      )}
    </div>
  );
}
