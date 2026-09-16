import { describe, expect, it } from "vitest";
import {
  applyNamePattern,
  buildPreview,
  isRunnable,
  isTargetContainer,
  isVideoPath,
  outputPath,
  resolveStemAvoidingCollision,
  streamCompatibility,
  streamIndicesForRemux,
  type MediaStreamInfo,
} from "./logic";

const mkStream = (
  index: number,
  codecType: string,
  codecName: string,
): MediaStreamInfo => ({
  index,
  codecType,
  codecName,
});

describe("video-remux logic", () => {
  it("recognizes supported video extensions", () => {
    expect(isVideoPath("C:\\Videos\\clip.mkv")).toBe(true);
    expect(isVideoPath("C:\\Videos\\clip.MP4")).toBe(true);
    expect(isVideoPath("C:\\Videos\\clip.ts")).toBe(true);
    expect(isVideoPath("C:\\Videos\\notes.txt")).toBe(false);
  });

  it("validates target containers", () => {
    expect(isTargetContainer("mp4")).toBe(true);
    expect(isTargetContainer("webm")).toBe(true);
    expect(isTargetContainer("ts")).toBe(true);
    expect(isTargetContainer("m4v")).toBe(true);
    expect(isTargetContainer("avi")).toBe(false);
  });

  it("applies name patterns with stem and index tokens", () => {
    expect(applyNamePattern("{stem}-remuxed", "movie", 1)).toBe("movie-remuxed");
    expect(applyNamePattern("{stem}-{n}", "movie", 3)).toBe("movie-3");
    expect(applyNamePattern("", "movie", 2)).toBe("movie-remuxed");
    expect(outputPath("D:\\Media\\movie.mkv", null, "mp4", "movie-remuxed")).toBe(
      "D:\\Media\\movie-remuxed.mp4",
    );
  });

  it("flags DTS audio as incompatible with mp4", () => {
    const streams = [
      mkStream(0, "video", "h264"),
      mkStream(1, "audio", "dts"),
    ];
    expect(streamCompatibility(streams[1], "mp4")).toBe("incompatible");
  });

  it("marks incompatible rows when drop toggle is off", () => {
    const mkv = "C:\\Videos\\clip.mkv";
    const streams = [
      mkStream(0, "video", "h264"),
      mkStream(1, "audio", "dts"),
    ];
    const streamsByPath = new Map([[mkv, streams]]);

    const preview = buildPreview(
      [mkv],
      "mp4",
      null,
      new Map(),
      "{stem}-remuxed",
      streamsByPath,
      false,
      [0, 1],
    );

    expect(preview[0].status).toBe("incompatible");
    expect(isRunnable(preview[0].status)).toBe(false);
  });

  it("allows remux with drop incompatible streams", () => {
    const mkv = "C:\\Videos\\clip.mkv";
    const streams = [
      mkStream(0, "video", "h264"),
      mkStream(1, "audio", "dts"),
    ];
    const streamsByPath = new Map([[mkv, streams]]);

    const preview = buildPreview(
      [mkv],
      "mp4",
      null,
      new Map(),
      "{stem}-remuxed",
      streamsByPath,
      true,
      null,
    );

    expect(preview[0].status).toBe("ready");
    expect(streamIndicesForRemux(streams, "mp4", true, null)).toEqual([0]);
  });

  it("marks same-container and collision rows as skipped", () => {
    const mkv = "C:\\Videos\\clip.mkv";
    const mp4 = "C:\\Videos\\clip.mp4";
    const other = "C:\\Videos\\other.mkv";
    const existsMap = new Map<string, boolean>([
      ["C:\\Videos\\other-remuxed.mp4", true],
    ]);

    const preview = buildPreview(
      [mkv, mp4, other],
      "mp4",
      null,
      existsMap,
      "{stem}-remuxed",
      new Map(),
      false,
      null,
    );

    expect(preview[0].status).toBe("ready");
    expect(preview[1].status).toBe("same_container");
    expect(preview[2].status).toBe("ready");
    expect(preview[2].to).toBe("C:\\Videos\\other-remuxed-2.mp4");
    expect(preview[2].bumped).toBe(true);
    expect(preview.filter((r) => isRunnable(r.status)).length).toBe(2);
  });

  it("detects duplicate targets within a batch", () => {
    const a = "C:\\Videos\\folder1\\movie.mkv";
    const b = "C:\\Videos\\folder2\\movie.mkv";
    const preview = buildPreview(
      [a, b],
      "mp4",
      "C:\\Out",
      new Map(),
      "{stem}-remuxed",
      new Map(),
      false,
      null,
    );

    expect(preview[0].status).toBe("ready");
    expect(preview[1].status).toBe("duplicate");
    expect(preview[0].to).toBe("C:\\Out\\movie-remuxed.mp4");
    expect(preview[1].to).toBe("C:\\Out\\movie-remuxed.mp4");
  });

  it("auto-bumps when output file already exists on disk", () => {
    const mkv = "C:\\Videos\\clip.mkv";
    const existsMap = new Map<string, boolean>([
      ["C:\\Videos\\clip-remuxed.mp4", true],
    ]);

    const preview = buildPreview(
      [mkv],
      "mp4",
      null,
      existsMap,
      "{stem}-remuxed",
      new Map(),
      false,
      null,
    );

    expect(preview[0].status).toBe("ready");
    expect(preview[0].to).toBe("C:\\Videos\\clip-remuxed-2.mp4");
    expect(preview[0].bumped).toBe(true);
  });

  it("resolves bumped stems from disk collisions only", () => {
    const mkv = "C:\\Videos\\clip.mkv";
    const existsMap = new Map<string, boolean>([
      ["C:\\Videos\\clip-remuxed.mp4", true],
      ["C:\\Videos\\clip-remuxed-2.mp4", true],
    ]);
    const resolved = resolveStemAvoidingCollision(
      "clip-remuxed",
      mkv,
      null,
      "mp4",
      existsMap,
    );
    expect(resolved.stem).toBe("clip-remuxed-3");
    expect(resolved.bumped).toBe(true);
  });

  it("uses per-file index token in batch patterns", () => {
    const a = "C:\\Videos\\a.mkv";
    const b = "C:\\Videos\\b.mkv";
    const preview = buildPreview(
      [a, b],
      "mp4",
      "C:\\Out",
      new Map(),
      "{stem}-{n}",
      new Map(),
      false,
      null,
    );

    expect(preview[0].to).toBe("C:\\Out\\a-1.mp4");
    expect(preview[1].to).toBe("C:\\Out\\b-2.mp4");
  });

  it("flags unsupported inputs", () => {
    const preview = buildPreview(
      ["C:\\Videos\\readme.txt"],
      "mp4",
      null,
      new Map(),
      "{stem}-remuxed",
      new Map(),
      false,
      null,
    );
    expect(preview[0].status).toBe("unsupported");
    expect(isRunnable(preview[0].status)).toBe(false);
  });
});
