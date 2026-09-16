import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProgressBar } from "../../ui/ProgressBar";
import {
  clampMp3Bitrate,
  DEFAULT_MP3_BITRATE,
  formatDuration,
  isLikelyMusicUrl,
  loadBool,
  loadString,
  makeJobId,
  MP3_BITRATES,
  platformLabel,
  sanitizeOutputStem,
  saveBool,
  saveString,
  STORAGE,
  type Mp3BitrateKbps,
} from "./logic";
import {
  cancelMusicJob,
  musicDownload,
  musicResolve,
  musicToolsVersion,
  revealInExplorer,
  type MusicDownloadItem,
  type MusicDownloadResult,
  type MusicTrackPreview,
} from "./io";

interface MusicProgressPayload {
  jobId: string;
  ratio: number;
  trackIndex: number;
  trackTotal: number;
  trackTitle?: string | null;
}

export default function MusicDownloaderTool() {
  const [url, setUrl] = useState("");
  const [outputDir, setOutputDir] = useState<string | null>(() =>
    loadString(STORAGE.outputDir) || null,
  );
  const [spotifyClientId, setSpotifyClientId] = useState(() =>
    loadString(STORAGE.spotifyClientId),
  );
  const [spotifyClientSecret, setSpotifyClientSecret] = useState(() =>
    loadString(STORAGE.spotifyClientSecret),
  );
  const [showSpotifyCreds, setShowSpotifyCreds] = useState(() =>
    loadBool(STORAGE.showSpotifyCreds),
  );
  const [mp3BitrateKbps, setMp3BitrateKbps] = useState<Mp3BitrateKbps>(() => {
    const stored = Number(loadString(STORAGE.mp3BitrateKbps, String(DEFAULT_MP3_BITRATE)));
    return clampMp3Bitrate(stored);
  });

  const [ytdlpVersion, setYtdlpVersion] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [collectionTitle, setCollectionTitle] = useState<string | null>(null);
  const [resolveNotice, setResolveNotice] = useState<string | null>(null);
  const [tracks, setTracks] = useState<MusicTrackPreview[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Downloading…");
  const [results, setResults] = useState<MusicDownloadResult[]>([]);
  const activeJobId = useRef<string | null>(null);

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

    void listen<MusicProgressPayload>("music-progress", (event) => {
      if (event.payload.jobId !== activeJobId.current) return;
      setProgress(event.payload.ratio);
      const title = event.payload.trackTitle ?? "track";
      setProgressLabel(
        `Downloading ${event.payload.trackIndex + 1} of ${event.payload.trackTotal}: ${title} (${Math.round(event.payload.ratio * 100)}%)`,
      );
    }).then((fn) => {
      unlistenProgress = fn;
    });

    return () => {
      unlistenProgress?.();
    };
  }, []);

  const allSelected = useMemo(
    () => tracks.length > 0 && selected.size === tracks.length,
    [tracks.length, selected.size],
  );

  const resetResolved = useCallback(() => {
    setPlatform(null);
    setCollectionTitle(null);
    setResolveNotice(null);
    setTracks([]);
    setSelected(new Set());
    setResults([]);
    setSummary(null);
  }, []);

  useEffect(() => {
    saveString(STORAGE.mp3BitrateKbps, String(mp3BitrateKbps));
  }, [mp3BitrateKbps]);

  const handleResolve = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Paste a YouTube or Spotify link.");
      return;
    }
    if (!isLikelyMusicUrl(trimmed)) {
      setError("Unsupported link. Use YouTube / YouTube Music or Spotify.");
      return;
    }

    setResolving(true);
    setError(null);
    setSummary(null);
    setResults([]);
    resetResolved();

    try {
      saveString(STORAGE.spotifyClientId, spotifyClientId.trim());
      saveString(STORAGE.spotifyClientSecret, spotifyClientSecret.trim());

      const resolved = await musicResolve({
        url: trimmed,
        spotifyClientId: spotifyClientId.trim() || null,
        spotifyClientSecret: spotifyClientSecret.trim() || null,
      });

      setPlatform(resolved.platform);
      setCollectionTitle(resolved.title ?? null);
      setResolveNotice(resolved.notice ?? null);
      setTracks(resolved.tracks);
      setSelected(new Set(resolved.tracks.map((t) => t.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve link.");
    } finally {
      setResolving(false);
    }
  }, [url, spotifyClientId, spotifyClientSecret, resetResolved]);

  const toggleTrack = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === tracks.length) return new Set();
      return new Set(tracks.map((t) => t.id));
    });
  }, [tracks]);

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

  const handleDownload = useCallback(async () => {
    if (!outputDir) {
      setError("Choose an output folder first.");
      return;
    }
    const chosen = tracks.filter((t) => selected.has(t.id));
    if (chosen.length === 0) {
      setError("Select at least one track.");
      return;
    }

    const items: MusicDownloadItem[] = chosen.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      downloadQuery: track.downloadQuery,
      outputStem: sanitizeOutputStem(track.artist, track.title),
      durationSecs: track.durationSecs ?? null,
    }));

    const jobId = makeJobId();
    activeJobId.current = jobId;
    setBusy(true);
    setProgress(0);
    setProgressLabel("Starting download…");
    setError(null);
    setSummary(null);
    setResults([]);

    try {
      const result = await musicDownload({ jobId, outputDir, items, audioQualityKbps: mp3BitrateKbps });
      setResults(result.results);
      const okCount = result.results.filter((r) => r.ok).length;
      const total = result.results.length;
      setProgress(total > 0 ? okCount / total : 0);
      if (result.ok) {
        setSummary(`Downloaded ${okCount} file${okCount === 1 ? "" : "s"}.`);
        setError(null);
      } else if (okCount > 0) {
        const failCount = total - okCount;
        setSummary(
          `Downloaded ${okCount} of ${total}. ${failCount} failed — see Results below.`,
        );
        setError(result.error ?? "Some tracks failed.");
      } else {
        setSummary(null);
        setError(result.error ?? "Download failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }, [outputDir, tracks, selected, mp3BitrateKbps]);

  const handleCancel = useCallback(async () => {
    const jobId = activeJobId.current;
    if (!jobId) return;
    try {
      await cancelMusicJob(jobId);
    } catch {
      /* ignore */
    }
  }, []);

  const isSpotify = platform === "spotify";

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <div>
          <label htmlFor="music-url" className="block text-sm font-medium text-zinc-300">
            Link
          </label>
          <input
            id="music-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://open.spotify.com/track/… or https://music.youtube.com/watch?v=…"
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
          <span className="text-sm text-zinc-400">MP3 bitrate</span>
          <select
            value={mp3BitrateKbps}
            onChange={(e) => setMp3BitrateKbps(clampMp3Bitrate(Number(e.target.value)))}
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none disabled:opacity-50"
          >
            {MP3_BITRATES.map((kbps) => (
              <option key={kbps} value={kbps}>
                {kbps} kbps
                {kbps === DEFAULT_MP3_BITRATE ? " (default)" : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-zinc-600">
            Lower bitrates save disk space; 320 kbps is best quality for MP3.
          </p>
        </label>

        {ytdlpVersion ? (
          <p className="text-xs text-zinc-500">
            yt-dlp {ytdlpVersion} · MP3 {mp3BitrateKbps} kbps
          </p>
        ) : null}
        {toolsError ? <p className="text-sm text-red-400">{toolsError}</p> : null}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <button
          type="button"
          onClick={() => {
            const next = !showSpotifyCreds;
            setShowSpotifyCreds(next);
            saveBool(STORAGE.showSpotifyCreds, next);
          }}
          className="text-sm text-zinc-300 hover:text-brand-soft"
        >
          {showSpotifyCreds ? "Hide" : "Show"} Spotify API credentials (optional fallback)
        </button>

        {showSpotifyCreds ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="spotify-client-id" className="block text-xs text-zinc-500">
                Client ID
              </label>
              <input
                id="spotify-client-id"
                value={spotifyClientId}
                onChange={(e) => setSpotifyClientId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="spotify-client-secret" className="block text-xs text-zinc-500">
                Client Secret
              </label>
              <input
                id="spotify-client-secret"
                type="password"
                value={spotifyClientSecret}
                onChange={(e) => setSpotifyClientSecret(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
            </div>
          </div>
        ) : null}

        <p className="text-xs text-zinc-500">
          Spotify embeds cap at 100 tracks. SAK then tries Spotify&apos;s web-player lookup for the
          full list. Developer Client ID / Secret (in <code className="text-zinc-400">.env</code> or
          below) only helps for playlists you own, and Spotify now requires Premium on the
          developer account for API track lists.
        </p>
      </section>

      {resolveNotice ? (
        <p className="text-sm text-amber-200/90 rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          {resolveNotice}
        </p>
      ) : null}

      {isSpotify ? (
        <p className="text-sm text-amber-200/90 rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          Spotify links are matched on YouTube for download — SAK does not rip the Spotify stream.
          Audio is saved as MP3 at the selected bitrate when the YouTube source allows it.
        </p>
      ) : null}

      {platform && tracks.length > 0 ? (
        <section className="rounded-xl border border-zinc-800 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/80 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-zinc-200">
                {platformLabel(platform)}
                {collectionTitle ? ` · ${collectionTitle}` : ""}
              </p>
              <p className="text-xs text-zinc-500">{tracks.length} track(s)</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={toggleAll}
                disabled={busy}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={busy || !outputDir || selected.size === 0}
                className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
              >
                Download selected
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-950 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2 w-10" />
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2 hidden sm:table-cell">Artist</th>
                  <th className="px-4 py-2 hidden md:table-cell">Duration</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <tr key={track.id} className="border-t border-zinc-800/80">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(track.id)}
                        onChange={() => toggleTrack(track.id)}
                        disabled={busy}
                      />
                    </td>
                    <td className="px-4 py-2 text-zinc-200">{track.title}</td>
                    <td className="px-4 py-2 hidden sm:table-cell text-zinc-400">
                      {track.artist}
                    </td>
                    <td className="px-4 py-2 hidden md:table-cell text-zinc-500">
                      {formatDuration(track.durationSecs ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {busy ? (
        <section className="space-y-3">
          <ProgressBar value={progress} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">{progressLabel}</p>
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-red-500/60 hover:text-red-300"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {summary ? <p className="text-sm text-emerald-400">{summary}</p> : null}

      {results.length > 0 ? (
        <section className="rounded-xl border border-zinc-800 overflow-hidden">
          <div className="border-b border-zinc-800 bg-zinc-900/80 px-4 py-3">
            <p className="text-sm font-medium text-zinc-200">Results</p>
          </div>
          <ul className="divide-y divide-zinc-800">
            {results.map((result) => (
              <li
                key={`${result.id}-${result.path}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <p className={result.ok ? "text-zinc-200" : "text-red-300"}>
                    {result.path.split(/[/\\]/).pop()}
                  </p>
                  {result.error ? (
                    <p className="text-xs text-red-400/90 mt-1">{result.error}</p>
                  ) : null}
                </div>
                {result.ok ? (
                  <button
                    type="button"
                    onClick={() => void revealInExplorer(result.path)}
                    className="text-xs text-brand hover:text-brand-soft"
                  >
                    Reveal in Explorer
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
