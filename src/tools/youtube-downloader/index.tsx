import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  cancelYoutubeJob,
  musicToolsVersion,
  revealInExplorer,
  youtubeDownload,
  youtubeResolve,
  type YoutubeResolveResult,
} from "./io";
import {
  clampQuality,
  DEFAULT_QUALITY,
  formatDuration,
  isYoutubeVideoUrl,
  loadBool,
  loadString,
  makeJobId,
  QUALITY_PRESETS,
  qualityLabel,
  type QualityPreset,
  sanitizeVideoStem,
  saveBool,
  saveString,
  STORAGE,
} from "./logic";

interface YoutubeProgressPayload {
  jobId: string;
  ratio: number;
}

export default function YoutubeDownloaderTool() {
  const [url, setUrl] = useState("");
  const [outputDir, setOutputDir] = useState<string | null>(
    () => loadString(STORAGE.outputDir) || null,
  );
  const [maxHeight, setMaxHeight] = useState<QualityPreset>(() => {
    const stored = Number(loadString(STORAGE.maxHeight, String(DEFAULT_QUALITY)));
    return clampQuality(stored);
  });
  const [writeSubs, setWriteSubs] = useState(() => loadBool(STORAGE.writeSubs, true));
  const [ytdlpVersion, setYtdlpVersion] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<YoutubeResolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Downloading…");
  const activeJobId = useRef<string | null>(null);
  const resolveGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void musicToolsVersion()
      .then((version) => {
        if (!cancelled) {
          setYtdlpVersion(version);
          setToolsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setYtdlpVersion(null);
          setToolsError(
            err instanceof Error
              ? err.message
              : "yt-dlp sidecar is not available. Run node scripts/setup-music-tools.mjs",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;

    void listen<YoutubeProgressPayload>("youtube-progress", (event) => {
      if (event.payload.jobId !== activeJobId.current) return;
      setProgress(event.payload.ratio);
      setProgressLabel(`Downloading… ${Math.round(event.payload.ratio * 100)}%`);
    }).then((fn) => {
      unlistenProgress = fn;
    });

    return () => {
      unlistenProgress?.();
    };
  }, []);

  const pickOutputDir = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose download folder",
    });
    if (typeof picked === "string") {
      setOutputDir(picked);
      saveString(STORAGE.outputDir, picked);
    }
  }, []);

  const handleResolve = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Paste a YouTube video URL.");
      return;
    }
    if (!isYoutubeVideoUrl(trimmed)) {
      setError(
        "Unsupported link. Use a YouTube watch, Shorts, live, or youtu.be video URL.",
      );
      return;
    }

    const gen = ++resolveGen.current;
    setResolving(true);
    setError(null);
    setSummary(null);
    setOutputPath(null);
    setPreview(null);

    try {
      const resolved = await youtubeResolve(trimmed);
      if (gen !== resolveGen.current) return;
      setPreview(resolved);
    } catch (err) {
      if (gen !== resolveGen.current) return;
      setError(err instanceof Error ? err.message : "Could not resolve video.");
    } finally {
      if (gen === resolveGen.current) setResolving(false);
    }
  }, [url]);

  const handleDownload = useCallback(async () => {
    if (!outputDir) {
      setError("Choose an output folder first.");
      return;
    }
    const trimmed = url.trim();
    if (!trimmed || !isYoutubeVideoUrl(trimmed)) {
      setError("Paste a valid YouTube video URL first.");
      return;
    }

    const jobId = makeJobId();
    activeJobId.current = jobId;
    setBusy(true);
    setProgress(0);
    setProgressLabel("Starting download…");
    setError(null);
    setSummary(null);
    setOutputPath(null);

    try {
      const result = await youtubeDownload({
        jobId,
        url: trimmed,
        outputDir,
        titleHint: preview?.title ? sanitizeVideoStem(preview.title) : null,
        maxHeight,
        writeSubs,
      });
      if (result.ok && result.path) {
        setProgress(1);
        setOutputPath(result.path);
        const subCount = result.subtitlePaths?.length ?? 0;
        setSummary(
          subCount > 0
            ? `Download complete · ${subCount} subtitle file${subCount === 1 ? "" : "s"}.`
            : writeSubs
              ? "Download complete · no subtitles available."
              : "Download complete.",
        );
        setError(null);
      } else {
        setSummary(null);
        setError(result.error ?? "Download failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }, [outputDir, url, preview, maxHeight, writeSubs]);

  const handleCancel = useCallback(async () => {
    const jobId = activeJobId.current;
    if (!jobId) return;
    try {
      await cancelYoutubeJob(jobId);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div>
          <label htmlFor="youtube-url" className="block text-sm font-medium text-zinc-300">
            Video URL
          </label>
          <input
            id="youtube-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              resolveGen.current += 1;
              setPreview(null);
              setSummary(null);
              setOutputPath(null);
            }}
            placeholder="https://www.youtube.com/watch?v=… or https://youtu.be/…"
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand/60 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleResolve()}
            disabled={resolving || busy || !!toolsError}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
          <button
            type="button"
            onClick={pickOutputDir}
            disabled={busy}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {outputDir ? "Change output folder" : "Choose output folder"}
          </button>
        </div>

        {outputDir ? (
          <p className="text-xs text-zinc-500 break-all">Output: {outputDir}</p>
        ) : (
          <p className="text-xs text-zinc-500">Pick a folder before downloading.</p>
        )}

        <label className="block max-w-xs">
          <span className="text-sm text-zinc-400">Quality</span>
          <select
            value={maxHeight}
            onChange={(e) => {
              const next = clampQuality(Number(e.target.value));
              setMaxHeight(next);
              saveString(STORAGE.maxHeight, String(next));
            }}
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none disabled:opacity-50"
          >
            {QUALITY_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
                {preset.value === DEFAULT_QUALITY ? " (default)" : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-zinc-600">
            Caps resolution; lower settings download faster and use less disk.
          </p>
        </label>

        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={writeSubs}
            onChange={(e) => {
              const next = e.target.checked;
              setWriteSubs(next);
              saveBool(STORAGE.writeSubs, next);
            }}
            disabled={busy}
            className="mt-0.5 rounded border-zinc-600"
          />
          <span>
            Download English subtitles (.srt) when available
            <span className="block text-xs text-zinc-600">
              Saves next to the video (e.g. Title.en-GB.srt). Manual captions preferred;
              auto-generated English used when needed.
            </span>
          </span>
        </label>

        {ytdlpVersion ? (
          <p className="text-xs text-zinc-500">
            yt-dlp {ytdlpVersion} · {qualityLabel(maxHeight)} MP4
            {writeSubs ? " · subtitles on" : ""}
          </p>
        ) : null}
        {toolsError ? <p className="text-sm text-red-400">{toolsError}</p> : null}
      </section>

      {preview ? (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex flex-col gap-4 sm:flex-row">
            {preview.thumbnailUrl ? (
              <img
                src={preview.thumbnailUrl}
                alt=""
                className="h-28 w-auto rounded-lg object-cover bg-zinc-950"
              />
            ) : null}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-zinc-100 break-words">{preview.title}</p>
              {preview.channel ? (
                <p className="text-xs text-zinc-400">{preview.channel}</p>
              ) : null}
              <p className="text-xs text-zinc-500">
                Duration {formatDuration(preview.durationSecs)} · {preview.videoId}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            {!busy ? (
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={!!toolsError || !outputDir}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
              >
                Download MP4
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleCancel()}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:border-brand/60"
              >
                Cancel
              </button>
            )}
          </div>
        </section>
      ) : null}

      {busy ? <ProgressBar value={progress} label={progressLabel} /> : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {summary ? <p className="text-sm text-emerald-400/90">{summary}</p> : null}

      {outputPath ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-zinc-500 break-all flex-1">{outputPath}</p>
          <button
            type="button"
            onClick={() => void revealInExplorer(outputPath)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
          >
            Reveal in Explorer
          </button>
        </div>
      ) : null}

      <p className="text-xs text-zinc-600">
        Downloads video+audio and muxes to MP4 locally at the selected quality. Nothing is
        uploaded; public videos only (no YouTube login). If downloads fail with HTTP 403, run{" "}
        <code className="text-zinc-400">node scripts/setup-music-tools.mjs</code> to refresh yt-dlp.
      </p>
    </div>
  );
}
