import { describe, expect, it } from "vitest";
import {
  applyNamePattern,
  audioModeForEncode,
  buildPreview,
  clampCrf,
  codecAllowsContainer,
  containersForCodec,
  defaultContainerForCodec,
  defaultCrf,
  isRunnable,
  isVideoCodec,
  isVideoPath,
  outputPath,
  resolveStemAvoidingCollision,
  scaleHeightForResolution,
  type MediaStreamInfo,
} from "./logic";

const mkStream = (
  index: number,
  codecType: string,
  codecName: string,
  size?: { width: number; height: number },
): MediaStreamInfo => ({
  index,
  codecType,
  codecName,
  width: size?.width,
  height: size?.height,
});

describe("video-encode logic", () => {
  it("recognizes supported video extensions", () => {
    expect(isVideoPath("C:\\Videos\\clip.mkv")).toBe(true);
    expect(isVideoPath("C:\\Videos\\clip.MP4")).toBe(true);
    expect(isVideoPath("C:\\Videos\\notes.txt")).toBe(false);
  });

  it("maps codecs to allowed containers", () => {
    expect(isVideoCodec("h264")).toBe(true);
    expect(containersForCodec("vp9")).toEqual(["webm", "mkv"]);
    expect(codecAllowsContainer("h264", "mp4")).toBe(true);
    expect(codecAllowsContainer("vp9", "mp4")).toBe(false);
    expect(defaultContainerForCodec("vp9")).toBe("webm");
    expect(defaultContainerForCodec("h264")).toBe("mp4");
  });

  it("clamps CRF per codec", () => {
    expect(defaultCrf("h264")).toBe(23);
    expect(clampCrf("h264", 99)).toBe(51);
    expect(clampCrf("vp9", -1)).toBe(0);
    expect(clampCrf("av1", 28.4)).toBe(28);
  });

  it("resolves resolution scale heights", () => {
    expect(scaleHeightForResolution("original")).toBeNull();
    expect(scaleHeightForResolution("720")).toBe(720);
  });

  it("applies name patterns with stem and index tokens", () => {
    expect(applyNamePattern("{stem}-encoded", "movie", 1)).toBe("movie-encoded");
    expect(applyNamePattern("{stem}-{n}", "movie", 3)).toBe("movie-3");
    expect(applyNamePattern("", "movie", 2)).toBe("movie-encoded");
    expect(outputPath("D:\\Media\\movie.mkv", null, "mp4", "movie-encoded")).toBe(
      "D:\\Media\\movie-encoded.mp4",
    );
  });

  it("chooses audio mode based on container compatibility", () => {
    const dts = [
      mkStream(0, "video", "h264", { width: 1920, height: 1080 }),
      mkStream(1, "audio", "dts"),
    ];
    expect(audioModeForEncode(dts, "mp4")).toBe("aac");
    expect(audioModeForEncode(dts, "webm")).toBe("opus");

    const aac = [
      mkStream(0, "video", "h264"),
      mkStream(1, "audio", "aac"),
    ];
    expect(audioModeForEncode(aac, "mp4")).toBe("copy");

    const opus = [
      mkStream(0, "video", "vp9"),
      mkStream(1, "audio", "opus"),
    ];
    expect(audioModeForEncode(opus, "webm")).toBe("copy");
  });

  it("bumps colliding output stems", () => {
    const source = "C:\\Videos\\clip.mp4";
    const exists = new Map([
      ["C:\\Videos\\clip-encoded.mp4", true],
    ]);
    const result = resolveStemAvoidingCollision(
      "clip-encoded",
      source,
      null,
      "mp4",
      exists,
    );
    expect(result.stem).toBe("clip-encoded-2");
    expect(result.bumped).toBe(true);
  });

  it("builds ready preview rows and warns when audio will re-encode", () => {
    const path = "C:\\Videos\\clip.mkv";
    const streams = [
      mkStream(0, "video", "h264", { width: 1280, height: 720 }),
      mkStream(1, "audio", "dts"),
    ];
    const preview = buildPreview(
      [path],
      "mp4",
      null,
      new Map(),
      "{stem}-encoded",
      "h264",
      new Map([[path, streams]]),
    );

    expect(preview[0].status).toBe("warn");
    expect(preview[0].warnReason).toContain("AAC");
    expect(isRunnable(preview[0].status)).toBe(true);
  });

  it("flags incompatible codec/container pairs", () => {
    const path = "C:\\Videos\\clip.mp4";
    const preview = buildPreview(
      [path],
      "mp4",
      null,
      new Map(),
      "{stem}-encoded",
      "vp9",
      new Map(),
    );
    expect(preview[0].status).toBe("incompatible");
    expect(isRunnable(preview[0].status)).toBe(false);
  });
});
