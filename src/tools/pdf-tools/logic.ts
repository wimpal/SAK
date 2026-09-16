export const PDF_EXTENSIONS = ["pdf"] as const;
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
] as const;

export type PdfMode = "open" | "edit" | "merge" | "convert" | "resize";
export type ConvertDirection = "pdf-to-images" | "images-to-pdf";
export type ImageFormat = "png" | "jpeg" | "webp";
export type PageFitMode = "fit" | "fill" | "original";
export type ResizeAnchor = "top-left" | "center";

export const MODES: { id: PdfMode; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "edit", label: "Edit" },
  { id: "merge", label: "Merge" },
  { id: "convert", label: "Convert" },
  { id: "resize", label: "Resize" },
];

/** Inclusive percent bounds for the Resize mode UI and ops. */
export const RESIZE_SCALE_PERCENT_MIN = 10;
export const RESIZE_SCALE_PERCENT_MAX = 100;
export const RESIZE_SCALE_PERCENT_DEFAULT = 50;

export const IMAGE_FORMATS: ImageFormat[] = ["png", "jpeg", "webp"];

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : path;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function fileStem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileExtension(path: string): string | null {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return name.slice(dot + 1);
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${file}`;
}

export function isPdfPath(path: string): boolean {
  return fileExtension(path) === "pdf";
}

export function isImagePath(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== null && (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

export function sanitizeOutputStem(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  if (lower.endsWith(".pdf")) {
    stem = stem.slice(0, -4);
  }
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) {
      stem = stem.slice(0, -(ext.length + 1));
      break;
    }
  }
  return stem.trim();
}

export function isValidOutputStem(name: string): boolean {
  return sanitizeOutputStem(name).length > 0;
}

export function defaultEditedStem(sourcePath: string): string {
  return `${fileStem(sourcePath)}-edited`;
}

export function defaultResizedStem(sourcePath: string): string {
  return `${fileStem(sourcePath)}-resized`;
}

/**
 * Clamp a percent value into [10, 100]. Returns null when the input is not a
 * finite number (empty field, NaN, etc.).
 */
export function clampScalePercent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(
    RESIZE_SCALE_PERCENT_MAX,
    Math.max(RESIZE_SCALE_PERCENT_MIN, value),
  );
}

/** Convert a UI percent (10–100) to a scale factor (0.10–1.0). */
export function scalePercentToFactor(percent: number): number {
  const clamped = clampScalePercent(percent);
  if (clamped === null) {
    throw new Error(
      `Scale must be a number between ${RESIZE_SCALE_PERCENT_MIN} and ${RESIZE_SCALE_PERCENT_MAX}`,
    );
  }
  return clamped / 100;
}

export function defaultMergedStem(firstPath: string): string {
  return `${fileStem(firstPath)}-merged`;
}

export function defaultImagesToPdfStem(firstPath: string): string {
  return `${fileStem(firstPath)}-from-images`;
}

export function defaultPagesFolderName(sourcePath: string): string {
  return `${fileStem(sourcePath)}-pages`;
}

export function pdfOutputPath(
  sourcePath: string,
  outputDir: string | null,
  stem: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  return joinPath(dir, `${sanitizeOutputStem(stem)}.pdf`);
}

export function imageOutputPath(
  dir: string,
  stem: string,
  page1Based: number,
  format: ImageFormat,
): string {
  const padded = String(page1Based).padStart(3, "0");
  return joinPath(dir, `${sanitizeOutputStem(stem)}-page-${padded}.${format}`);
}

export function pagesOutputDir(
  sourcePath: string,
  outputDir: string | null,
  folderName: string,
): string {
  const parent = outputDir ?? dirname(sourcePath);
  return joinPath(parent, sanitizeOutputStem(folderName));
}

/** Bump `stem`, `stem-2`, `stem-3`, … until `buildPath(stem)` is free. */
export function resolveStemAvoidingCollision(
  initialStem: string,
  existsMap: Map<string, boolean>,
  buildPath: (stem: string) => string,
): { stem: string; path: string; bumped: boolean } {
  const sanitized = sanitizeOutputStem(initialStem);
  const base = sanitized.match(/^(.*)-(\d+)$/)?.[1] ?? sanitized;
  let candidate = sanitized;
  let bumped = false;
  let n = 2;

  for (let guard = 0; guard < 10000; guard++) {
    const path = buildPath(candidate);
    if (existsMap.get(path) !== true) {
      return { stem: candidate, path, bumped };
    }
    candidate = `${base}-${n}`;
    bumped = true;
    n += 1;
  }

  const path = buildPath(sanitized);
  return { stem: sanitized, path, bumped: false };
}

/**
 * Parse 1-based page ranges like `1-3, 7, 9-10`.
 * Returns sorted unique 0-based indices, or an error message.
 */
export function parsePageRanges(
  input: string,
  pageCount: number,
): { indices: number[] } | { error: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0 || /^all$/i.test(trimmed)) {
    return {
      indices: Array.from({ length: pageCount }, (_, i) => i),
    };
  }

  const parts = trimmed.split(/[,;\s]+/).filter((p) => p.length > 0);
  const set = new Set<number>();

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < 1 ||
        start > pageCount ||
        end > pageCount ||
        start > end
      ) {
        return { error: `Invalid range: ${part}` };
      }
      for (let p = start; p <= end; p++) set.add(p - 1);
      continue;
    }

    const single = Number(part);
    if (!Number.isInteger(single) || single < 1 || single > pageCount) {
      return { error: `Invalid page: ${part}` };
    }
    set.add(single - 1);
  }

  return { indices: [...set].sort((a, b) => a - b) };
}

export function formatPageCountPreview(
  entries: { label: string; count: number }[],
): string {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (entries.length === 0) return "0 pages";
  if (entries.length === 1) return `${total} page${total === 1 ? "" : "s"}`;
  return `${total} pages from ${entries.length} files`;
}

export function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length ||
    from === to
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function dpiToScale(dpi: number): number {
  return Math.max(36, Math.min(600, dpi)) / 72;
}
