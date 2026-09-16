import { describe, expect, it } from "vitest";
import {
  defaultEpubStem,
  epubOutputPath,
  isPdfPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";

describe("isPdfPath", () => {
  it("accepts pdf extension", () => {
    expect(isPdfPath("C:\\docs\\book.pdf")).toBe(true);
    expect(isPdfPath("/tmp/book.PDF")).toBe(true);
  });

  it("rejects non-pdf", () => {
    expect(isPdfPath("C:\\docs\\book.epub")).toBe(false);
    expect(isPdfPath("C:\\docs\\book")).toBe(false);
  });
});

describe("sanitizeOutputStem / epubOutputPath", () => {
  it("strips illegal chars and extensions", () => {
    expect(sanitizeOutputStem("a/b:c.pdf")).toBe("abc");
    expect(sanitizeOutputStem("book.epub")).toBe("book");
  });

  it("builds epub output next to source", () => {
    expect(epubOutputPath("C:\\docs\\a.pdf", null, "a")).toBe(
      "C:\\docs\\a.epub",
    );
    expect(epubOutputPath("C:\\docs\\a.pdf", "D:\\out", "a")).toBe(
      "D:\\out\\a.epub",
    );
  });

  it("defaults stem from pdf filename", () => {
    expect(defaultEpubStem("C:\\docs\\report.pdf")).toBe("report");
  });
});

describe("resolveStemAvoidingCollision", () => {
  it("bumps when target exists", () => {
    const exists = new Map([
      ["C:\\report.epub", true],
      ["C:\\report-2.epub", true],
    ]);
    const resolved = resolveStemAvoidingCollision(
      "report",
      exists,
      (s) => `C:\\${s}.epub`,
    );
    expect(resolved).toEqual({
      stem: "report-3",
      path: "C:\\report-3.epub",
      bumped: true,
    });
  });
});
