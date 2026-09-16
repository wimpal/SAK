import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import { ProgressBar } from "../../ui/ProgressBar";
import { TrimEditor } from "./TrimEditor";
import {
  basename,
  defaultOutputName,
  DEFAULT_FPS,
  isValidOutputName,
  isVideoPath,
  MIN_SELECTION_SECS,
  nextAvailableOutputStemAfter,
  outputPath,
  sanitizeOutputName,
  summarizeSession,
  upsertSessionResult,
  type SessionResult,
} from "./logic";

interface MediaProbe {
  durationSecs: number;
  fps: number;
}

interface TrimClipResult {
  path: string;
  ok: boolean;
  error?: string;
}

type Phase = "intake" | "review" | "summary";

const STORAGE = {
  recursive: "sak.clip-trimmer.recursive",
} as const;

const videoFilters = [
  {
    name: "Video",
    extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv"],
  },
];

function loadBool(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "true";
  } catch {
    return fallback;
  }
}

function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

async function pathsExist(paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("paths_exist", { paths });
}

export default function ClipTrimmerTool() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [queue, setQueue] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [recursive, setRecursive] = useState(() => loadBool(STORAGE.recursive));

  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputName, setOutputName] = useState("");
  const [outputExists, setOutputExists] = useState(false);
  const [accurateCut, setAccurateCut] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);

  const isBatch = queue.length > 1;
  const busy = loading || trimming || deleting;

  useEffect(() => {
    saveBool(STORAGE.recursive, recursive);
  }, [recursive]);

  const clearMedia = useCallback(() => {
    setSourcePath(null);
    setVideoSrc(null);
    setDuration(0);
    setFps(DEFAULT_FPS);
    setInPoint(0);
    setOutPoint(0);
    setOutputName("");
    setLoadError(null);
  }, []);

  const loadClip = useCallback(
    async (path: string, opts?: { resetPrefs?: boolean }) => {
      if (!isVideoPath(path)) {
        setLoadError(
          "Please choose a supported video file (MP4, MOV, MKV, WebM, AVI, M4V, WMV).",
        );
        return false;
      }

      setLoadError(null);
      setSummary(null);
      setLastSavedPath(null);
      setLoading(true);
      setSourcePath(path);
      setOutputName("");
      setVideoSrc(null);
      setDuration(0);
      setFps(DEFAULT_FPS);
      setInPoint(0);
      setOutPoint(0);
      if (opts?.resetPrefs) {
        setAccurateCut(false);
        setOutputDir(null);
      }

      try {
        const probe = await invoke<MediaProbe>("probe_media", { path });
        setVideoSrc(convertFileSrc(path));
        setDuration(probe.durationSecs);
        setFps(probe.fps > 0 ? probe.fps : DEFAULT_FPS);
        setInPoint(0);
        setOutPoint(probe.durationSecs);
        setOutputName(defaultOutputName(path));
        return true;
      } catch (err) {
        setSourcePath(null);
        setVideoSrc(null);
        setDuration(0);
        setFps(DEFAULT_FPS);
        setInPoint(0);
        setOutPoint(0);
        setOutputName("");
        setLoadError(
          typeof err === "string" ? err : "Could not load the selected video.",
        );
        return false;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const startReview = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setQueue(paths);
      setIndex(0);
      setSessionResults([]);
      setPhase("review");
      setSummary(null);
      setLastSavedPath(null);
      await loadClip(paths[0], { resetPrefs: true });
    },
    [loadClip],
  );

  const addPaths = useCallback(
    async (incoming: string[]) => {
      if (phase !== "intake") return;
      setLoadError(null);
      try {
        const expanded = await invoke<string[]>("expand_intake_paths", {
          paths: incoming,
          recursive,
        });
        const videos = expanded.filter(isVideoPath);
        if (videos.length === 0) {
          setLoadError(
            "No supported video files found (MP4, MOV, MKV, WebM, AVI, M4V, WMV).",
          );
          return;
        }

        let autoStart: string[] | null = null;
        setQueue((prev) => {
          const next = [...new Set([...prev, ...videos])];
          // Single-file quick path: empty → one clip enters review immediately.
          if (prev.length === 0 && next.length === 1) {
            autoStart = next;
          }
          return next;
        });
        if (autoStart) {
          void startReview(autoStart);
        }
      } catch (err) {
        setLoadError(
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : "Could not read selected paths.",
        );
      }
    },
    [phase, recursive, startReview],
  );

  function clearIntake() {
    setQueue([]);
    setLoadError(null);
  }

  function resetToIntake() {
    setPhase("intake");
    setQueue([]);
    setIndex(0);
    setSessionResults([]);
    clearMedia();
    setOutputDir(null);
    setAccurateCut(false);
    setSummary(null);
    setLastSavedPath(null);
    setTrimming(false);
    setDeleting(false);
  }

  function goToSummary(nextIndex: number) {
    setIndex(nextIndex);
    setPhase("summary");
    clearMedia();
  }

  async function advanceAfterSuccess(fromIndex: number) {
    const next = fromIndex + 1;
    if (next >= queue.length) {
      goToSummary(next);
      return;
    }
    setIndex(next);
    setSummary(null);
    setLastSavedPath(null);
    await loadClip(queue[next], { resetPrefs: false });
  }

  useEffect(() => {
    if (!sourcePath) {
      setOutputExists(false);
      return;
    }

    let cancelled = false;
    const path = outputPath(sourcePath, outputDir, outputName);

    async function refresh() {
      const exists = await pathsExist([path]);
      if (!cancelled) setOutputExists(exists[0]);
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [sourcePath, outputDir, outputName]);

  async function chooseOutputFolder() {
    const selected = await open({ directory: true });
    if (typeof selected === "string") {
      setOutputDir(selected);
      setSummary(null);
      setLastSavedPath(null);
    }
  }

  function handleInChange(value: number) {
    setInPoint(value);
    setSummary(null);
  }

  function handleOutChange(value: number) {
    setOutPoint(value);
    setSummary(null);
  }

  async function trimClip() {
    if (!sourcePath || !isValidOutputName(outputName)) return;

    const stem = sanitizeOutputName(outputName);
    const targetPath = outputPath(sourcePath, outputDir, stem);
    const currentIndex = index;
    const currentPath = sourcePath;

    setTrimming(true);
    setSummary(null);
    try {
      const result = await invoke<TrimClipResult>("trim_clip", {
        sourcePath,
        outputPath: targetPath,
        startSecs: inPoint,
        endSecs: outPoint,
        accurate: accurateCut,
      });

      if (result.ok) {
        setSessionResults((prev) =>
          upsertSessionResult(prev, {
            path: currentPath,
            action: "trimmed",
            outputPath: result.path,
          }),
        );
        setLastSavedPath(result.path);

        if (isBatch) {
          await advanceAfterSuccess(currentIndex);
        } else {
          setSummary(`Saved to ${basename(result.path)}.`);
          const nextStem = await nextAvailableOutputStemAfter(
            sourcePath,
            outputDir,
            stem,
            pathsExist,
          );
          setOutputName(nextStem);
          setOutputExists(false);
        }
      } else if (result.error === "target already exists") {
        setSessionResults((prev) =>
          upsertSessionResult(prev, {
            path: currentPath,
            action: "failed",
            detail: "target already exists",
          }),
        );
        setSummary("Skipped — file already exists.");
        setLastSavedPath(null);
        setOutputExists(true);
      } else {
        const detail = result.error ?? "Trim failed.";
        setSessionResults((prev) =>
          upsertSessionResult(prev, {
            path: currentPath,
            action: "failed",
            detail,
          }),
        );
        setSummary(detail);
        const exists = await pathsExist([targetPath]);
        setOutputExists(exists[0]);
      }
    } catch (err) {
      const detail =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Trim failed.";
      setSessionResults((prev) =>
        upsertSessionResult(prev, {
          path: currentPath,
          action: "failed",
          detail,
        }),
      );
      setSummary(detail);
    } finally {
      setTrimming(false);
    }
  }

  async function deleteCurrentClip() {
    if (!sourcePath || !isBatch) return;

    const name = basename(sourcePath);
    const confirmed = window.confirm(
      `Move "${name}" to the Recycle Bin?\n\nYou can restore it from the Recycle Bin later.`,
    );
    if (!confirmed) return;

    const currentIndex = index;
    const currentPath = sourcePath;

    setDeleting(true);
    setSummary(null);
    try {
      await invoke("trash_file", { path: currentPath });
      setSessionResults((prev) =>
        upsertSessionResult(prev, {
          path: currentPath,
          action: "deleted",
        }),
      );
      await advanceAfterSuccess(currentIndex);
    } catch (err) {
      const detail =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Delete failed.";
      setSessionResults((prev) =>
        upsertSessionResult(prev, {
          path: currentPath,
          action: "failed",
          detail,
        }),
      );
      setSummary(detail);
    } finally {
      setDeleting(false);
    }
  }

  function endBatch() {
    goToSummary(index);
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

  const nameValid = isValidOutputName(outputName);
  const outputFile =
    sourcePath !== null && nameValid
      ? outputPath(sourcePath, outputDir, outputName)
      : null;
  const selectionValid =
    duration > 0 &&
    outPoint - inPoint >= MIN_SELECTION_SECS &&
    outPoint <= duration;
  const canTrim =
    sourcePath !== null &&
    videoSrc !== null &&
    nameValid &&
    selectionValid &&
    !outputExists &&
    !busy;
  const canDelete = isBatch && sourcePath !== null && !busy && !loading;

  const remainingOnSummary = Math.max(0, queue.length - index);
  const sessionSummaryText = summarizeSession(sessionResults, remainingOnSummary);
  const failedResults = sessionResults.filter((r) => r.action === "failed");
  const lastTrimmed = [...sessionResults]
    .reverse()
    .find((r) => r.action === "trimmed" && r.outputPath);

  if (phase === "summary") {
    return (
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Batch complete</h2>
          <p className="text-sm text-zinc-300" role="status">
            {sessionSummaryText}
          </p>
          {failedResults.length > 0 && (
            <ul className="rounded-xl border border-zinc-800 divide-y divide-zinc-800 text-sm">
              {failedResults.map((r) => (
                <li key={r.path} className="px-3 py-2 text-amber-400">
                  <span className="font-mono text-xs text-zinc-400">
                    {basename(r.path)}
                  </span>
                  {r.detail ? ` — ${r.detail}` : " — failed"}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={resetToIntake}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
            >
              New batch
            </button>
            {lastTrimmed?.outputPath && (
              <button
                type="button"
                onClick={() => {
                  setLastSavedPath(lastTrimmed.outputPath!);
                  void invoke("reveal_in_explorer", {
                    path: lastTrimmed.outputPath,
                  }).catch((err: unknown) => {
                    setSummary(
                      typeof err === "string"
                        ? err
                        : err instanceof Error
                          ? err.message
                          : "Could not open folder.",
                    );
                  });
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm hover:border-zinc-500 transition-colors"
              >
                Show last trim
              </button>
            )}
          </div>
          {summary && (
            <p className="text-sm text-red-400" role="alert">
              {summary}
            </p>
          )}
        </section>
      </div>
    );
  }

  if (phase === "intake") {
    return (
      <div className="space-y-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FilePickerButton
              label="Choose videos"
              multiple
              filters={videoFilters}
              onPick={(paths) => void addPaths(paths)}
            />
            <FilePickerButton
              label="Choose folder"
              directory
              onPick={(paths) => void addPaths(paths)}
            />
            {queue.length > 0 && (
              <button
                type="button"
                onClick={clearIntake}
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

          <DropZone onDrop={(paths) => void addPaths(paths)}>
            <p className="text-sm text-zinc-400 min-h-[160px] flex items-center justify-center">
              Drop videos or a folder here, or use the buttons above.
            </p>
          </DropZone>

          {loadError && (
            <p className="text-sm text-red-400" role="alert">
              {loadError}
            </p>
          )}

          {queue.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">
                Selected videos ({queue.length})
              </h2>
              <ul className="max-h-52 overflow-y-auto rounded-xl border border-zinc-800 divide-y divide-zinc-800">
                {queue.map((path) => (
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
                      onClick={() =>
                        setQueue((prev) => prev.filter((p) => p !== path))
                      }
                      className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void startReview(queue)}
                className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
              >
                Start{queue.length > 1 ? ` (${queue.length} clips)` : ""}
              </button>
            </section>
          )}
        </section>
      </div>
    );
  }

  // phase === "review"
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {isBatch ? (
            <>
              <p className="text-sm font-medium text-zinc-300">
                Clip {index + 1} of {queue.length}
              </p>
              <button
                type="button"
                onClick={endBatch}
                disabled={busy}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 disabled:opacity-40 transition-colors"
              >
                End batch
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={resetToIntake}
              disabled={busy}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 disabled:opacity-40 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {loadError && (
          <p className="text-sm text-red-400" role="alert">
            {loadError}
          </p>
        )}

        {loading && <p className="text-sm text-zinc-400">Loading video…</p>}

        {sourcePath && videoSrc && duration > 0 && !loading && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-400 truncate" title={sourcePath}>
              {basename(sourcePath)}
            </p>
            <TrimEditor
              videoSrc={videoSrc}
              duration={duration}
              fps={fps}
              inPoint={inPoint}
              outPoint={outPoint}
              onInChange={handleInChange}
              onOutChange={handleOutChange}
            />
          </div>
        )}
      </section>

      {sourcePath && (
        <section className="space-y-4 border-t border-zinc-800 pt-6">
          <h2 className="text-sm font-medium text-zinc-300">Output</h2>

          <div className="space-y-2">
            <label
              className="block text-xs text-zinc-500"
              htmlFor="trim-output-name"
            >
              File name
            </label>
            <input
              id="trim-output-name"
              type="text"
              value={outputName}
              onChange={(event) => {
                setOutputName(event.target.value);
                setSummary(null);
                setLastSavedPath(null);
              }}
              className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void chooseOutputFolder()}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:border-zinc-500 transition-colors"
            >
              {outputDir ? "Change output folder" : "Choose output folder"}
            </button>
            {outputDir && (
              <span className="text-xs text-zinc-500 truncate max-w-full">
                {outputDir}
              </span>
            )}
          </div>

          {outputFile && (
            <p className="text-xs text-zinc-500 break-all">
              {outputExists ? (
                <span className="text-amber-400">
                  Output exists — choose another name or folder: {outputFile}
                </span>
              ) : (
                <>Will save to {outputFile}</>
              )}
            </p>
          )}

          {trimming && <ProgressBar value={0.35} label="Trimming…" />}
          {deleting && <ProgressBar value={0.35} label="Deleting…" />}

          <div className="space-y-3">
            <label className="inline-flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={accurateCut}
                onChange={(e) => setAccurateCut(e.target.checked)}
                className="rounded border-zinc-600 bg-zinc-900 text-brand focus:ring-brand/50"
              />
              Accurate cut (re-encode)
            </label>
            <p className="text-xs text-zinc-500">
              {accurateCut
                ? "Frame-accurate cuts via H.264 re-encode — slower, may change size slightly."
                : "Lossless stream-copy — fast, but cuts may snap to nearby keyframes."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void trimClip()}
              disabled={!canTrim}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Trim
            </button>
            {isBatch && (
              <button
                type="button"
                onClick={() => void deleteCurrentClip()}
                disabled={!canDelete}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2 text-sm text-zinc-300 hover:border-red-500/60 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Delete
              </button>
            )}
          </div>

          {summary && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-zinc-300" role="status">
                {summary}
              </p>
              {!isBatch && lastSavedPath && (
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
        </section>
      )}
    </div>
  );
}
