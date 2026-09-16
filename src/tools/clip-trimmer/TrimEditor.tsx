import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import {
  clampTime,
  formatDuration,
  formatTime,
  frameStep,
  MIN_SELECTION_SECS,
  nudgeTime,
} from "./logic";

type DragMode = "in" | "out" | "seek" | null;

interface TrimEditorProps {
  videoSrc: string;
  duration: number;
  fps: number;
  inPoint: number;
  outPoint: number;
  onInChange: (value: number) => void;
  onOutChange: (value: number) => void;
}

const HANDLE_WIDTH = 12;

function positionFromTime(time: number, duration: number, width: number): number {
  if (duration <= 0 || width <= 0) return 0;
  return (time / duration) * width;
}

function timeFromPosition(x: number, duration: number, width: number): number {
  if (width <= 0) return 0;
  return clampTime((x / width) * duration, 0, duration);
}

function NudgeButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
    >
      {label}
    </button>
  );
}

export function TrimEditor({
  videoSrc,
  duration,
  fps,
  inPoint,
  outPoint,
  onInChange,
  onOutChange,
}: TrimEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [loopSelection, setLoopSelection] = useState(true);

  const frame = frameStep(fps);
  const selectionDuration = Math.max(0, outPoint - inPoint);

  const markIn = useCallback(() => {
    onInChange(clampTime(currentTime, 0, outPoint - MIN_SELECTION_SECS));
  }, [currentTime, onInChange, outPoint]);

  const markOut = useCallback(() => {
    onOutChange(
      clampTime(currentTime, inPoint + MIN_SELECTION_SECS, duration),
    );
  }, [currentTime, duration, inPoint, onOutChange]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    function updateWidth() {
      setTrackWidth(el!.clientWidth);
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function onTimeUpdate() {
      const t = video!.currentTime;
      setCurrentTime(t);
      if (t >= outPoint && outPoint < duration) {
        if (loopSelection) {
          video!.currentTime = inPoint;
        } else {
          video!.pause();
          video!.currentTime = inPoint;
          setPlaying(false);
        }
      }
    }

    function onPlay() {
      setPlaying(true);
    }

    function onPause() {
      setPlaying(false);
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [inPoint, outPoint, duration, loopSelection]);

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;
      const clamped = clampTime(time, 0, duration);
      video.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration],
  );

  const playFromIn = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = inPoint;
    void video.play();
  }, [inPoint]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      if (video.currentTime < inPoint || video.currentTime >= outPoint) {
        video.currentTime = inPoint;
      }
      void video.play();
    } else {
      video.pause();
    }
  }, [inPoint, outPoint]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        markIn();
      } else if (key === "o") {
        event.preventDefault();
        markOut();
      } else if (key === " " || key === "k") {
        event.preventDefault();
        togglePlay();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [markIn, markOut, togglePlay]);

  function nudgeIn(delta: number) {
    onInChange(nudgeTime(inPoint, delta, 0, outPoint - MIN_SELECTION_SECS));
  }

  function nudgeOut(delta: number) {
    onOutChange(
      nudgeTime(outPoint, delta, inPoint + MIN_SELECTION_SECS, duration),
    );
  }

  function handleTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (!track || duration <= 0) return;

    const rect = track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const width = rect.width;
    const inX = positionFromTime(inPoint, duration, width);
    const outX = positionFromTime(outPoint, duration, width);

    let mode: DragMode = "seek";
    if (Math.abs(x - inX) <= HANDLE_WIDTH) {
      mode = "in";
    } else if (Math.abs(x - outX) <= HANDLE_WIDTH) {
      mode = "out";
    }

    dragRef.current = mode;
    track.setPointerCapture(event.pointerId);

    if (mode === "seek") {
      seekTo(timeFromPosition(x, duration, width));
    } else if (mode === "in") {
      onInChange(
        clampTime(
          timeFromPosition(x, duration, width),
          0,
          outPoint - MIN_SELECTION_SECS,
        ),
      );
    } else {
      onOutChange(
        clampTime(
          timeFromPosition(x, duration, width),
          inPoint + MIN_SELECTION_SECS,
          duration,
        ),
      );
    }
  }

  function handleTrackPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const mode = dragRef.current;
    const track = trackRef.current;
    if (!mode || !track || duration <= 0) return;

    const rect = track.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const width = rect.width;
    const time = timeFromPosition(x, duration, width);

    if (mode === "seek") {
      seekTo(time);
    } else if (mode === "in") {
      onInChange(clampTime(time, 0, outPoint - MIN_SELECTION_SECS));
    } else if (mode === "out") {
      onOutChange(clampTime(time, inPoint + MIN_SELECTION_SECS, duration));
    }
  }

  function handleTrackPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    trackRef.current?.releasePointerCapture(event.pointerId);
  }

  const inLeft =
    trackWidth > 0 ? positionFromTime(inPoint, duration, trackWidth) : 0;
  const outLeft =
    trackWidth > 0 ? positionFromTime(outPoint, duration, trackWidth) : 0;
  const playheadLeft =
    trackWidth > 0 ? positionFromTime(currentTime, duration, trackWidth) : 0;
  const selectionWidth = Math.max(0, outLeft - inLeft);

  return (
    <div className="space-y-3">
      <video
        ref={videoRef}
        src={videoSrc}
        className="w-full max-h-[min(420px,56vh)] rounded-lg bg-black"
        controls
        preload="metadata"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <button
          type="button"
          onClick={togglePlay}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 transition-colors"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <Pause className="size-4" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
        <button
          type="button"
          onClick={playFromIn}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 transition-colors"
        >
          Play selection
        </button>
        <button
          type="button"
          onClick={markIn}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 transition-colors"
        >
          Mark In
        </button>
        <button
          type="button"
          onClick={markOut}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 hover:border-zinc-500 transition-colors"
        >
          Mark Out
        </button>
        <label className="inline-flex items-center gap-2 text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={loopSelection}
            onChange={(e) => setLoopSelection(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-900 text-brand focus:ring-brand/50"
          />
          Loop selection
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-zinc-300 tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <span className="text-zinc-500">
          Selection {formatTime(inPoint)} → {formatTime(outPoint)} (
          {formatDuration(selectionDuration)})
        </span>
        <span className="text-zinc-600 text-xs">
          I / Mark In · O / Mark Out · Space = play/pause
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative h-12 rounded-lg bg-zinc-800 touch-none select-none"
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerUp}
        role="slider"
        aria-label="Trim timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentTime}
      >
        {trackWidth > 0 && (
          <>
            <div
              className="absolute inset-y-2 left-0 rounded-l bg-zinc-900/80"
              style={{ width: `${inLeft}px` }}
            />
            <div
              className="absolute inset-y-2 rounded bg-brand/35 border-y border-brand/50"
              style={{ left: `${inLeft}px`, width: `${selectionWidth}px` }}
            />
            <div
              className="absolute inset-y-2 right-0 rounded-r bg-zinc-900/80"
              style={{ width: `${trackWidth - outLeft}px` }}
            />
            <div
              className="absolute top-1 bottom-1 w-0.5 bg-white shadow-sm pointer-events-none"
              style={{
                left: `${playheadLeft}px`,
                transform: "translateX(-50%)",
              }}
            />
            <div
              className="absolute top-0 bottom-0 w-3 rounded bg-brand cursor-ew-resize"
              style={{ left: `${inLeft}px`, transform: "translateX(-50%)" }}
              title="In point"
            />
            <div
              className="absolute top-0 bottom-0 w-3 rounded bg-brand cursor-ew-resize"
              style={{ left: `${outLeft}px`, transform: "translateX(-50%)" }}
              title="Out point"
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-zinc-400 w-6">In</span>
          <NudgeButton label="−1f" onClick={() => nudgeIn(-frame)} />
          <NudgeButton label="+1f" onClick={() => nudgeIn(frame)} />
          <NudgeButton label="−0.1s" onClick={() => nudgeIn(-0.1)} />
          <NudgeButton label="+0.1s" onClick={() => nudgeIn(0.1)} />
          <NudgeButton label="−1s" onClick={() => nudgeIn(-1)} />
          <NudgeButton label="+1s" onClick={() => nudgeIn(1)} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-zinc-400 w-8">Out</span>
          <NudgeButton label="−1f" onClick={() => nudgeOut(-frame)} />
          <NudgeButton label="+1f" onClick={() => nudgeOut(frame)} />
          <NudgeButton label="−0.1s" onClick={() => nudgeOut(-0.1)} />
          <NudgeButton label="+0.1s" onClick={() => nudgeOut(0.1)} />
          <NudgeButton label="−1s" onClick={() => nudgeOut(-1)} />
          <NudgeButton label="+1s" onClick={() => nudgeOut(1)} />
        </div>
      </div>
    </div>
  );
}
