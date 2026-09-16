export type PreviewStatus =
  | "ready"
  | "add_ext"
  | "noop"
  | "case_only"
  | "exists"
  | "duplicate"
  | "incompatible";

export type FileCategory =
  | "video"
  | "audio"
  | "image"
  | "document"
  | "archive"
  | "code"
  | "data";

export interface PreviewRow {
  from: string;
  to: string;
  status: PreviewStatus;
}

const APPLYABLE: PreviewStatus[] = ["ready", "add_ext", "case_only"];

const EXT_CATEGORIES: Record<string, FileCategory> = {
  // video
  mp4: "video", mkv: "video", avi: "video", mov: "video", wmv: "video",
  flv: "video", webm: "video", m4v: "video", mpg: "video", mpeg: "video",
  ts: "video", m2ts: "video", vob: "video", "3gp": "video", ogv: "video",
  // audio
  mp3: "audio", wav: "audio", flac: "audio", aac: "audio", ogg: "audio",
  m4a: "audio", wma: "audio", opus: "audio", aiff: "audio", ape: "audio",
  // image
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  bmp: "image", tiff: "image", tif: "image", svg: "image", ico: "image",
  heic: "image", heif: "image", avif: "image",
  // document
  pdf: "document", doc: "document", docx: "document", xls: "document",
  xlsx: "document", ppt: "document", pptx: "document", txt: "document",
  rtf: "document", odt: "document", ods: "document", md: "document",
  // archive
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  bz2: "archive", xz: "archive",
  // code
  tsx: "code", jsx: "code", js: "code", py: "code", rs: "code", java: "code",
  go: "code", cpp: "code", c: "code", h: "code", cs: "code", html: "code",
  css: "code", scss: "code", vue: "code", svelte: "code",
  // data
  json: "data", xml: "data", yaml: "data", yml: "data", csv: "data", toml: "data",
};

const CATEGORY_LABELS: Record<FileCategory, string> = {
  video: "video",
  audio: "audio",
  image: "image",
  document: "document",
  archive: "archive",
  code: "code",
  data: "data",
};

/** Strip leading dots and lowercase. */
export function normalizeExt(input: string): string {
  return input.trim().replace(/^\.+/, "").toLowerCase();
}

export function isValidExt(ext: string): boolean {
  return ext.length > 0 && /^[a-z0-9][a-z0-9._-]*$/i.test(ext);
}

/** Parse comma-separated extensions; drops empty segments. */
export function parseFilterExts(input: string): string[] {
  return input
    .split(",")
    .map(normalizeExt)
    .filter((ext) => ext.length > 0);
}

export function isValidFilterExts(input: string): boolean {
  const exts = parseFilterExts(input);
  if (exts.length === 0) return input.trim().length === 0;
  return exts.every(isValidExt);
}

export function getCategory(ext: string): FileCategory | null {
  return EXT_CATEGORIES[normalizeExt(ext)] ?? null;
}

export function categoryLabel(cat: FileCategory): string {
  return CATEGORY_LABELS[cat];
}

/** Block cross-type renames (e.g. video → image). Extensionless sources are unrestricted. */
export function areExtensionsCompatible(
  fromExt: string | null,
  toExt: string,
): boolean {
  if (fromExt === null) return true;
  const fromCat = getCategory(fromExt);
  const toCat = getCategory(toExt);
  if (fromCat === null && toCat === null) return true;
  if (fromCat === null || toCat === null) return false;
  return fromCat === toCat;
}

export function incompatibleReason(
  fromExt: string | null,
  toExt: string,
): string | null {
  if (areExtensionsCompatible(fromExt, toExt)) return null;
  const fromCat = fromExt ? getCategory(fromExt) : null;
  const toCat = getCategory(toExt);
  if (fromCat && toCat) {
    return `Cannot rename ${categoryLabel(fromCat)} to ${categoryLabel(toCat)}`;
  }
  return "Extension type not recognized for this rename";
}

export function isApplyable(status: PreviewStatus): boolean {
  return APPLYABLE.includes(status);
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function getExtension(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Unique extensions present in the selection, sorted. */
export function collectExtensions(paths: string[]): string[] {
  const set = new Set<string>();
  for (const path of paths) {
    const ext = getExtension(path);
    if (ext) set.add(ext);
  }
  return [...set].sort();
}

/** Toggle an extension in a comma-separated filter string. */
export function toggleFilterExt(current: string, ext: string): string {
  const normalized = normalizeExt(ext);
  const exts = parseFilterExts(current);
  const next = exts.includes(normalized)
    ? exts.filter((e) => e !== normalized)
    : [...exts, normalized].sort();
  return next.join(", ");
}

/** Replace (or add) the extension on a full path, preserving separators. */
export function withExtension(path: string, ext: string): string {
  const usesBackslash = path.includes("\\");
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const sep = usesBackslash ? "\\" : "/";
  const dirPart = dir.replace(/\//g, sep);
  return `${dirPart}${base}.${ext}`;
}

function initialStatus(from: string, to: string): PreviewStatus {
  if (from === to) return "noop";
  if (from.toLowerCase() === to.toLowerCase()) return "case_only";
  if (getExtension(from) === null) return "add_ext";
  return "ready";
}

export function buildPreview(
  paths: string[],
  newExt: string,
  fromFilter: string | undefined,
  existsMap: Map<string, boolean>,
): PreviewRow[] {
  const normalizedNew = normalizeExt(newExt);
  const normalizedFrom = fromFilter?.trim()
    ? parseFilterExts(fromFilter)
    : null;

  const filtered = paths.filter((path) => {
    if (!normalizedFrom || normalizedFrom.length === 0) return true;
    const ext = getExtension(path);
    return ext !== null && normalizedFrom.includes(ext);
  });

  const targetCounts = new Map<string, number>();
  const rows: PreviewRow[] = filtered.map((from) => {
    const to = withExtension(from, normalizedNew);
    const key = to.toLowerCase();
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    return { from, to, status: initialStatus(from, to) };
  });

  return rows.map((row) => {
    if (row.status === "noop") return row;

    const duplicateTarget = (targetCounts.get(row.to.toLowerCase()) ?? 0) > 1;
    if (duplicateTarget) {
      return { ...row, status: "duplicate" };
    }

    if (row.status === "ready") {
      const fromExt = getExtension(row.from);
      if (!areExtensionsCompatible(fromExt, normalizedNew)) {
        return { ...row, status: "incompatible" };
      }
    }

    const existsOnDisk = existsMap.get(row.to) ?? false;
    const sameFileIgnoreCase =
      row.from.toLowerCase() === row.to.toLowerCase();
    if (existsOnDisk && !sameFileIgnoreCase) {
      return { ...row, status: "exists" };
    }

    return row;
  });
}
