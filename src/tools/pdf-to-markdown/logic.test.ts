import { describe, expect, it } from "vitest";
import {
  defaultMarkdownStem,
  isPdfPath,
  markdownOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";

describe("isPdfPath", () => {
  it("accepts pdf extension", () => {
    expect(isPdfPath("C:\\docs\\book.pdf")).toBe(true);
    expect(isPdfPath("/tmp/book.PDF")).toBe(true);
  });

  it("rejects non-pdf", () => {
    expect(isPdfPath("C:\\docs\\book.md")).toBe(false);
    expect(isPdfPath("C:\\docs\\book")).toBe(false);
  });
});

describe("sanitizeOutputStem / markdownOutputPath", () => {
  it("strips illegal chars and extensions", () => {
    expect(sanitizeOutputStem("a/b:c.pdf")).toBe("abc");
    expect(sanitizeOutputStem("book.md")).toBe("book");
    expect(sanitizeOutputStem("notes.markdown")).toBe("notes");
  });

  it("builds markdown output next to source", () => {
    expect(markdownOutputPath("C:\\docs\\a.pdf", null, "a")).toBe(
      "C:\\docs\\a.md",
    );
    expect(markdownOutputPath("C:\\docs\\a.pdf", "D:\\out", "a")).toBe(
      "D:\\out\\a.md",
    );
  });

  it("defaults stem from pdf filename", () => {
    expect(defaultMarkdownStem("C:\\docs\\report.pdf")).toBe("report");
  });
});

describe("resolveStemAvoidingCollision", () => {
  it("bumps when target exists", () => {
    const exists = new Map([
      ["C:\\report.md", true],
      ["C:\\report-2.md", true],
    ]);
    const resolved = resolveStemAvoidingCollision(
      "report",
      exists,
      (s) => `C:\\${s}.md`,
    );
    expect(resolved).toEqual({
      stem: "report-3",
      path: "C:\\report-3.md",
      bumped: true,
    });
  });
});
