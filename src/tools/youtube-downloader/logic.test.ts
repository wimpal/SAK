import { describe, expect, it } from "vitest";
import {
  clampQuality,
  DEFAULT_QUALITY,
  formatDuration,
  isYoutubeVideoUrl,
  parseYoutubeVideoUrl,
  qualityLabel,
  sanitizeVideoStem,
} from "./logic";

describe("parseYoutubeVideoUrl", () => {
  it("accepts watch, shorts, live, embed, and youtu.be", () => {
    const cases = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ];
    for (const url of cases) {
      const parsed = parseYoutubeVideoUrl(url);
      expect(parsed?.videoId).toBe("dQw4w9WgXcQ");
      expect(parsed?.canonical).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(isYoutubeVideoUrl(url)).toBe(true);
    }
  });

  it("rejects hostile and non-video URLs", () => {
    const cases = [
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://example.com/?u=https://youtube.com/watch?v=dQw4w9WgXcQ",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/playlist?list=PLxxxx",
      "https://www.youtube.com/@SomeChannel",
      "https://www.youtube.com/channel/UCxxxx",
      "https://youtu.be/short",
      "",
    ];
    for (const url of cases) {
      expect(parseYoutubeVideoUrl(url)).toBeNull();
      expect(isYoutubeVideoUrl(url)).toBe(false);
    }
  });
});

describe("sanitizeVideoStem", () => {
  it("strips invalid characters and reserved names", () => {
    expect(sanitizeVideoStem("100%(complete)")).not.toContain("%");
    expect(sanitizeVideoStem("CON").startsWith("_")).toBe(true);
    expect(sanitizeVideoStem("   ")).toBe("video");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("quality presets", () => {
  it("clamps unknown values to default", () => {
    expect(clampQuality(1080)).toBe(1080);
    expect(clampQuality(0)).toBe(0);
    expect(clampQuality(999)).toBe(DEFAULT_QUALITY);
    expect(qualityLabel(720)).toBe("720p");
    expect(qualityLabel(0)).toBe("Best available");
  });
});
