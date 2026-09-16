import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  basename,
  buildPreview,
  clampQualityLevel,
  codecAllowsContainer,
  codecLabel,
  containersForCodec,
  crfFromQualityLevel,
  DEFAULT_NAME_PATTERN,
  DEFAULT_QUALITY_LEVEL,
  DEFAULT_TARGET_MB,
  defaultContainerForCodec,
  defaultOutputStem,
  estimateHint,
  formatBytes,
  isReduceMode,
  isResolutionId,
  isRunnable,
  isTargetContainer,
  isValidNamePattern,
  isVideoCodec,
  isVideoPath,
  mbToBytes,
  QUALITY_SLIDER,
  RESOLUTION_OPTIONS,
  scaleHeightForResolution,
  sourceVideoSize,
  statusClass,
  statusLabel,
  type MediaStreamsProbe,
  type PreviewRow,
  type ReduceMode,
  type ResolutionId,
  type RowResult,
  type TargetContainer,
  type VideoCodec,
} from "./logic";

const STORAGE = {
  videoCodec: "sak.size-reducer.videoCodec",
  targetContainer: "sak.size-reducer.targetContainer",
  mode: "sak.size-reducer.mode",
  targetMb: "sak.size-reducer.targetMb",
  qualityLevel: "sak.size-reducer.qualityLevel",
  resolution: "sak.size-reducer.resolution",
  recursive: "sak.size-reducer.recursive",
  outputDir: "sak.size-reducer.outputDir",
  namePattern: "sak.size-reducer.namePattern",
} as const;

const videoFilters = [
  {
    name: "Video",
    extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "ts"],
  },
];

interface ReduceResult {
  path: string;
  ok: boolean;
  error?: string;
}

interface FfmpegProgressPayload {
  jobId: string;
  ratio: number;
}

function loadString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadBool(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "true";
  } catch {
    return fallback;
  }
}

function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function makeJobId(): string {
  return `reduce-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function SizeReducerTool() {
  const [paths, setPaths] = useState<string[]>([]);
  const [videoCodec, setVideoCodec] = useState<VideoCodec>(() => {
    const stored = loadString(STORAGE.videoCodec, "h264");
    return isVideoCodec(stored) ? stored : "h264";
  });
  const [targetContainer, setTargetContainer] = useState<TargetContainer>(() => {
    const codecStored = loadString(STORAGE.videoCodec, "h264");
    const codec = isVideoCodec(codecStored) ? codecStored : "h264";
    const stored = loadString(STORAGE.targetContainer, "mp4");
    if (isTargetContainer(stored) && codecAllowsContainer(codec, stored)) {
      return stored;
    }
    return defaultContainerForCodec(codec);
  });
  const [mode, setMode] = useState<ReduceMode>(() => {
    const stored = loadString(STORAGE.mode, "target");
    return isReduceMode(stored) ? stored : "target";
  });
  const [targetMb, setTargetMb] = useState(() => {
    const stored = Number(loadString(STORAGE.targetMb, String(DEFAULT_TARGET_MB)));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TARGET_MB;
  });
  const [qualityLevel, setQualityLevel] = useState(() => {
    const stored = Number(
      loadString(STORAGE.qualityLevel, String(DEFAULT_QUALITY_LEVEL)),
    );
    return clampQualityLevel(stored);
  });
  const [resolution, setResolution] = useState<ResolutionId>(() => {
    const stored = loadString(STORAGE.resolution, "original");
    return isResolutionId(stored) ? stored : "original";
  });
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [namePattern, setNamePattern] = useState(() =>
    loadString(STORAGE.namePattern, DEFAULT_NAME_PATTERN),
  );
  const [recursive, setRecursive] = useState(() => loadBool(STORAGE.recursive));
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [streamsByPath, setStreamsByPath] = useState<
    Map<string, MediaStreamsProbe["streams"]>
  >(new Map());
  const [durationsByPath, setDurationsByPath] = useState<Map<string, number>>(
    new Map(),
  );
  const [sizesByPath, setSizesByPath] = useState<Map<string, number>>(new Map());
  const [rowResults, setRowResults] = useState<Map<string, RowResult>>(
    new Map(),
  );
  const [reducing, setReducing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [outputDirReady, setOutputDirReady] = useState(false);

  const cancelRequestedRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);
  const fileIndexRef = useRef(0);
  const readyCountRef = useRef(0);

  useEffect(() => {
    saveString(STORAGE.videoCodec, videoCodec);
  }, [videoCodec]);

  useEffect(() => {
    saveString(STORAGE.targetContainer, targetContainer);
  }, [targetContainer]);

  useEffect(() => {
    saveString(STORAGE.mode, mode);
  }, [mode]);

  useEffect(() => {
    saveString(STORAGE.targetMb, String(targetMb));
  }, [targetMb]);

  useEffect(() => {
    saveString(STORAGE.qualityLevel, String(qualityLevel));
  }, [qualityLevel]);

  useEffect(() => {
    saveString(STORAGE.resolution, resolution);
  }, [resolution]);

  useEffect(() => {
    saveBool(STORAGE.recursive, recursive);
  }, [recursive]);

  useEffect(() => {
    saveString(STORAGE.namePattern, namePattern);
  }, [namePattern]);

  useEffect(() => {
    if (!codecAllowsContainer(videoCodec, targetContainer)) {
      setTargetContainer(defaultContainerForCodec(videoCodec));
    }
  }, [videoCodec, targetContainer]);

  useEffect(() => {
    let cancelled = false;

    async function restoreOutputDir() {
      const stored = loadString(STORAGE.outputDir, "");
      if (!stored) {
        if (!cancelled) setOutputDirReady(true);
        return;
      }

      try {
        const exists = await invoke<boolean[]>("paths_exist", {
          paths: [stored],
        });
        if (!cancelled) {
          setOutputDir(exists[0] ? stored : null);
          if (!exists[0]) {
            saveString(STORAGE.outputDir, "");
          }
          setOutputDirReady(true);
        }
      } catch {
        if (!cancelled) setOutputDirReady(true);
      }
    }

    restoreOutputDir();
    return () => {
      cancelled = true;
    };
  }, []);

  const addPaths = useCallback(
    async (incoming: string[]) => {
      const expanded = await invoke<string[]>("expand_intake_paths", {
        paths: incoming,
        recursive,
      });
      const videos = expanded.filter(isVideoPath);
      setPaths((prev) => [...new Set([...prev, ...videos])]);
      setSummary(null);
      setLastSavedPath(null);
      setRowResults(new Map());
    },
    [recursive],
  );

  useEffect(() => {
    if (paths.length === 0) {
      setNamePattern((prev) =>
        prev === DEFAULT_NAME_PATTERN ? prev : DEFAULT_NAME_PATTERN,
      );
    } else if (paths.length === 1) {
      setNamePattern((prev) =>
        prev.trim() === "" ? defaultOutputStem(paths[0]) : prev,
      );
    }
  }, [paths]);

  useEffect(() => {
    let cancelled = false;

    async function probeAll() {
      if (paths.length === 0) {
        if (!cancelled) {
          setStreamsByPath(new Map());
          setDurationsByPath(new Map());
          setSizesByPath(new Map());
        }
        return;
      }

      const nextStreams = new Map<string, MediaStreamsProbe["streams"]>();
      const nextDurations = new Map<string, number>();
      const nextSizes = new Map<string, number>();

      for (const path of paths) {
        try {
          const probe = await invoke<MediaStreamsProbe>("probe_media_streams", {
            path,
          });
          if (cancelled) return;
          nextStreams.set(path, probe.streams);
          nextDurations.set(path, probe.durationSecs);
          nextSizes.set(path, probe.sizeBytes ?? 0);
        } catch {
          if (cancelled) return;
          nextStreams.set(path, []);
          nextDurations.set(path, 0);
          nextSizes.set(path, 0);
        }
      }

      if (cancelled) return;
      setStreamsByPath(nextStreams);
      setDurationsByPath(nextDurations);
      setSizesByPath(nextSizes);
    }

    probeAll();
    return () => {
      cancelled = true;
    };
  }, [paths]);

  const targetBytes = mbToBytes(targetMb);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (!outputDirReady) return;

      if (paths.length === 0) {
        if (!cancelled) setPreview([]);
        return;
      }

      const trimmedPattern = namePattern.trim();
      const pattern =
        trimmedPattern.length > 0 && isValidNamePattern(trimmedPattern)
          ? trimmedPattern
          : DEFAULT_NAME_PATTERN;

      const draft = buildPreview({
        paths,
        targetContainer,
        outputDir,
        existsMap: new Map(),
        namePattern: pattern,
        videoCodec,
        streamsByPath,
        sizesByPath,
        durationsByPath,
        mode,
        targetBytes,
        qualityLevel,
      });

      const targets = draft
        .filter((r) => isRunnable(r.status))
        .map((r) => r.to);
      const exists =
        targets.length > 0
          ? await invoke<boolean[]>("paths_exist", { paths: targets })
          : [];

      if (cancelled) return;

      const existsMap = new Map<string, boolean>();
      targets.forEach((target, i) => existsMap.set(target, exists[i]));

      setPreview(
        buildPreview({
          paths,
          targetContainer,
          outputDir,
          existsMap,
          namePattern: pattern,
          videoCodec,
          streamsByPath,
          sizesByPath,
          durationsByPath,
          mode,
          targetBytes,
          qualityLevel,
        }),
      );
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [
    paths,
    targetContainer,
    outputDir,
    namePattern,
    videoCodec,
    streamsByPath,
    sizesByPath,
    durationsByPath,
    mode,
    targetBytes,
    qualityLevel,
    outputDirReady,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<FfmpegProgressPayload>("ffmpeg-progress", (event) => {
      if (event.payload.jobId !== activeJobIdRef.current) return;
      const fileRatio = event.payload.ratio;
      const total = readyCountRef.current;
      if (total <= 0) return;
      const combined = (fileIndexRef.current + fileRatio) / total;
      setProgress(combined);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  async function chooseOutputFolder() {
    const selected = await open({ directory: true });
    if (typeof selected === "string") {
      setOutputDir(selected);
      saveString(STORAGE.outputDir, selected);
      setSummary(null);
      setLastSavedPath(null);
    }
  }

  function removePath(path: string) {
    setPaths((prev) => prev.filter((p) => p !== path));
    setSummary(null);
    setLastSavedPath(null);
    setRowResults(new Map());
  }

  function clearAll() {
    setPaths([]);
    setPreview([]);
    setSummary(null);
    setLastSavedPath(null);
    setRowResults(new Map());
    setNamePattern(DEFAULT_NAME_PATTERN);
  }

  async function cancelReduce() {
    cancelRequestedRef.current = true;
    const jobId = activeJobIdRef.current;
    if (jobId) {
      try {
        await invoke("cancel_ffmpeg_job", { jobId });
      } catch {
        /* job may have finished */
      }
    }
  }

  async function reduceAll() {
    const ready = preview.filter((r) => isRunnable(r.status));
    if (ready.length === 0) return;

    setReducing(true);
    setProgress(0);
    setSummary(null);
    setLastSavedPath(null);
    cancelRequestedRef.current = false;
    readyCountRef.current = ready.length;
    fileIndexRef.current = 0;
    activeJobIdRef.current = null;

    const results = new Map<string, RowResult>();
    for (const row of preview) {
      if (!isRunnable(row.status)) {
        results.set(row.from, { status: "skipped" });
      }
    }
    setRowResults(new Map(results));

    let succeeded = 0;
    let failed = 0;
    let cancelled = 0;
    let skipped = preview.length - ready.length;
    let lastOk: string | null = null;
    const scaleHeight = scaleHeightForResolution(resolution);
    const crf = crfFromQualityLevel(videoCodec, qualityLevel);

    for (let i = 0; i < ready.length; i++) {
      if (cancelRequestedRef.current) {
        for (let j = i; j < ready.length; j++) {
          results.set(ready[j].from, { status: "cancelled" });
        }
        cancelled = ready.length - i;
        break;
      }

      const row = ready[i];
      fileIndexRef.current = i;
      setProgress(i / ready.length);
      results.set(row.from, { status: "reducing" });
      setRowResults(new Map(results));

      const jobId = makeJobId();
      activeJobIdRef.current = jobId;

      try {
        const result = await invoke<ReduceResult>("reduce_video_size", {
          jobId,
          sourcePath: row.from,
          outputPath: row.to,
          videoCodec,
          mode,
          targetBytes: mode === "target" ? targetBytes : null,
          crf: mode === "quality" ? crf : null,
          scaleHeight,
          durationSecs: durationsByPath.get(row.from) ?? null,
        });

        if (result.ok) {
          succeeded += 1;
          lastOk = result.path;
          results.set(row.from, { status: "ok" });
        } else if (result.error === "cancelled") {
          cancelled += 1;
          results.set(row.from, {
            status: "cancelled",
            error: result.error,
          });
          for (let j = i + 1; j < ready.length; j++) {
            results.set(ready[j].from, { status: "cancelled" });
          }
          break;
        } else if (result.error === "target already exists") {
          skipped += 1;
          results.set(row.from, {
            status: "skipped",
            error: result.error,
          });
        } else {
          failed += 1;
          results.set(row.from, {
            status: "failed",
            error: result.error,
          });
        }
      } catch (err) {
        if (cancelRequestedRef.current) {
          cancelled += 1;
          results.set(row.from, { status: "cancelled" });
        } else {
          failed += 1;
          results.set(row.from, {
            status: "failed",
            error:
              typeof err === "string"
                ? err
                : err instanceof Error
                  ? err.message
                  : "Reduce failed",
          });
        }
      }

      activeJobIdRef.current = null;
      setRowResults(new Map(results));
      setProgress((i + 1) / ready.length);
    }

    setReducing(false);
    setProgress(0);
    cancelRequestedRef.current = false;

    const parts = [`${succeeded} reduced`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    setSummary(`${parts.join(", ")}.`);
    if (lastOk) setLastSavedPath(lastOk);
  }

  async function revealSavedFile() {
    if (!lastSavedPath) return;
    try {
      await invoke("reveal_in_explorer", { path: lastSavedPath });
    } catch (err) {
      setSummary(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Could not open folder.",
      );
    }
  }

  const sortedPaths = [...paths].sort((a, b) =>
    basename(a).localeCompare(basename(b)),
  );
  const trimmedPattern = namePattern.trim();
  const patternValid =
    trimmedPattern.length === 0 || isValidNamePattern(trimmedPattern);
  const runnableCount = preview.filter((r) => isRunnable(r.status)).length;
  const skipCount = preview.filter((r) => !isRunnable(r.status)).length;
  const showPreview = preview.length > 0;
  const allowedContainers = containersForCodec(videoCodec);
  const sampleStreams =
    paths.length === 1 ? (streamsByPath.get(paths[0]) ?? []) : [];
  const sampleSize = sourceVideoSize(sampleStreams);
  const qualityCrf = crfFromQualityLevel(videoCodec, qualityLevel);

  function displayStatus(row: PreviewRow): string {
    const result = rowResults.get(row.from);
    if (result) {
      return statusLabel(result.status, row.bumped);
    }
    return statusLabel(row.status, row.bumped);
  }

  function displayStatusClass(row: PreviewRow): string {
    const result = rowResults.get(row.from);
    if (result) return statusClass(result.status);
    return statusClass(row.status);
  }

  function displayError(row: PreviewRow): string | undefined {
    const result = rowResults.get(row.from);
    if (result?.error) return result.error;
    if (!result && row.warnReason) return row.warnReason;
    return undefined;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilePickerButton
            label="Choose videos"
            multiple
            filters={videoFilters}
            onPick={addPaths}
          />
          <FilePickerButton
            label="Choose folder"
            directory
            onPick={addPaths}
          />
          {paths.length > 0 && (
            <button
              type="button"
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

        <DropZone onDrop={addPaths}>Drop videos or a folder here</DropZone>

        {paths.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-zinc-300">
              Selected videos ({paths.length})
            </h2>
            <ul className="max-h-52 overflow-y-auto rounded-xl border border-zinc-800 divide-y divide-zinc-800">
              {sortedPaths.map((path) => (
                <li
                  key={path}
                  className="flex items-center gap-2 px-3 py-2 text-zinc-300"
                  title={path}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {basename(path)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removePath(path)}
                    className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-brand-soft transition-colors"
                    aria-label={`Remove ${basename(path)}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>

      <section className="space-y-3">
        <span className="text-sm text-zinc-400">Mode</span>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: "target" as const, label: "Target size" },
              { id: "quality" as const, label: "Quality" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                setMode(option.id);
                setSummary(null);
                setLastSavedPath(null);
                setRowResults(new Map());
              }}
              className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                mode === option.id
                  ? "border-brand bg-brand/10 text-zinc-100"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {mode === "target" ? (
          <label className="block max-w-xs">
            <span className="text-sm text-zinc-400">Target size (MB)</span>
            <input
              type="number"
              min={0.1}
              step={1}
              value={targetMb}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value > 0) {
                  setTargetMb(value);
                } else if (e.target.value === "") {
                  setTargetMb(0);
                }
                setSummary(null);
                setLastSavedPath(null);
                setRowResults(new Map());
              }}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
            />
            <p className="mt-1 text-xs text-zinc-600">
              One-pass ABR; actual size may vary ±10–20%.
            </p>
          </label>
        ) : (
          <label className="block max-w-md">
            <span className="text-sm text-zinc-400">
              Quality — CRF {qualityCrf} (smaller ↔ better)
            </span>
            <input
              type="range"
              min={QUALITY_SLIDER.min}
              max={QUALITY_SLIDER.max}
              value={qualityLevel}
              onChange={(e) => {
                setQualityLevel(clampQualityLevel(Number(e.target.value)));
                setSummary(null);
                setLastSavedPath(null);
                setRowResults(new Map());
              }}
              className="mt-2 w-full accent-brand"
            />
            <div className="mt-1 flex justify-between text-xs text-zinc-600">
              <span>Smaller</span>
              <span>Better</span>
            </div>
          </label>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm text-zinc-400">Video codec</span>
          <select
            value={videoCodec}
            onChange={(e) => {
              const value = e.target.value;
              if (!isVideoCodec(value)) return;
              setVideoCodec(value);
              setSummary(null);
              setLastSavedPath(null);
              setRowResults(new Map());
            }}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          >
            {(["h264", "h265"] as const).map((codec) => (
              <option key={codec} value={codec}>
                {codecLabel(codec)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-zinc-400">Target container</span>
          <select
            value={targetContainer}
            onChange={(e) => {
              const value = e.target.value;
              if (isTargetContainer(value)) {
                setTargetContainer(value);
                setSummary(null);
                setLastSavedPath(null);
                setRowResults(new Map());
              }
            }}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          >
            {allowedContainers.map((container) => (
              <option key={container} value={container}>
                .{container}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-zinc-400">Resolution</span>
          <select
            value={resolution}
            onChange={(e) => {
              const value = e.target.value;
              if (isResolutionId(value)) {
                setResolution(value);
                setSummary(null);
                setLastSavedPath(null);
                setRowResults(new Map());
              }
            }}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          >
            {RESOLUTION_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {sampleSize && (
            <p className="mt-1 text-xs text-zinc-600">
              Source: {sampleSize.width}×{sampleSize.height}
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-sm text-zinc-400">Output name pattern</span>
          <input
            type="text"
            value={namePattern}
            onChange={(e) => {
              setNamePattern(e.target.value);
              setSummary(null);
              setLastSavedPath(null);
              setRowResults(new Map());
            }}
            placeholder="{stem}-smaller"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none"
          />
          {trimmedPattern && !patternValid && (
            <span className="mt-1 block text-xs text-brand-soft">
              Enter a valid pattern ({`{stem}`}, {`{n}`}).
            </span>
          )}
          <p className="mt-1 text-xs text-zinc-600">
            Tokens: {`{stem}`}, {`{n}`} (1-based index). Collisions auto-bump.
          </p>
        </label>

        <div className="block sm:col-span-2">
          <span className="text-sm text-zinc-400">Output folder</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void chooseOutputFolder()}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:border-zinc-500 transition-colors"
            >
              {outputDir ? "Change output folder" : "Choose output folder"}
            </button>
            {outputDir && (
              <button
                type="button"
                onClick={() => {
                  setOutputDir(null);
                  saveString(STORAGE.outputDir, "");
                  setSummary(null);
                  setLastSavedPath(null);
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 transition-colors"
              >
                Clear folder
              </button>
            )}
            {outputDir && (
              <span className="text-xs text-zinc-500 truncate max-w-full">
                {outputDir}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-600">
            Default: sibling file next to each source. Last folder is remembered.
          </p>
        </div>
      </section>

      {showPreview && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-zinc-300">
              Preview — {runnableCount} of {paths.length} files
            </h2>
            {skipCount > 0 && (
              <span className="text-xs text-brand-soft">
                {skipCount} will be skipped
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600">{estimateHint(mode)}</p>

          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">From</th>
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Est.</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => {
                  const error = displayError(row);
                  return (
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
                      <td className="px-4 py-2 text-xs text-zinc-400">
                        {formatBytes(row.sourceBytes ?? 0)}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-400">
                        {row.estimatedBytes
                          ? formatBytes(row.estimatedBytes)
                          : "—"}
                      </td>
                      <td
                        className={`px-4 py-2 text-xs ${displayStatusClass(row)}`}
                        title={error ?? undefined}
                      >
                        <span>{displayStatus(row)}</span>
                        {error && (
                          <span className="mt-0.5 block truncate max-w-xs text-zinc-500">
                            {error}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-4">
        {reducing && (
          <ProgressBar
            value={progress}
            label={`Reducing… (${Math.round(progress * 100)}%)`}
          />
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => void reduceAll()}
            disabled={runnableCount === 0 || reducing || !patternValid}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          >
            {reducing ? "Reducing…" : `Reduce (${runnableCount})`}
          </button>

          {reducing && (
            <button
              type="button"
              onClick={() => void cancelReduce()}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2 text-sm text-zinc-300 hover:border-zinc-500 transition-colors"
            >
              Cancel
            </button>
          )}

          {summary && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-zinc-300" role="status">
                {summary}
              </p>
              {lastSavedPath && (
                <button
                  type="button"
                  onClick={() => void revealSavedFile()}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 transition-colors"
                >
                  Show in folder
                </button>
              )}
            </div>
          )}
        </div>

        <p className="text-xs text-zinc-500">
          Compresses with H.264 or H.265 (medium preset). Target-size mode uses
          one-pass ABR; quality mode uses CRF. Audio is re-encoded to AAC 128k.
          Never overwrites the source.
        </p>
      </section>
    </div>
  );
}
