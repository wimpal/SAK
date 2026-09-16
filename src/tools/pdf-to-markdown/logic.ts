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

export function sanitizeOutputStem(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  if (lower.endsWith(".pdf")) {
    stem = stem.slice(0, -4);
  }
  if (lower.endsWith(".md")) {
    stem = stem.slice(0, -3);
  }
  if (lower.endsWith(".markdown")) {
    stem = stem.slice(0, -9);
  }
  return stem.trim();
}

export function isValidOutputStem(name: string): boolean {
  return sanitizeOutputStem(name).length > 0;
}

export function defaultMarkdownStem(sourcePath: string): string {
  return fileStem(sourcePath);
}

export function markdownOutputPath(
  sourcePath: string,
  outputDir: string | null,
  stem: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  return joinPath(dir, `${sanitizeOutputStem(stem)}.md`);
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

export function makeJobId(): string {
  return `pdf-to-markdown-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
