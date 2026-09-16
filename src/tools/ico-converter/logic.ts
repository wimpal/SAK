export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;
export type IcoSize = (typeof ICO_SIZES)[number];

export const DEFAULT_SIZES: IcoSize[] = [16, 32, 48, 256];

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

export interface CropRect {
  x: number;
  y: number;
  size: number;
}

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

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${file}`;
}

export function isImagePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1));
}

export function centeredSquareCrop(
  width: number,
  height: number,
): CropRect {
  const size = Math.min(width, height);
  return {
    x: Math.floor((width - size) / 2),
    y: Math.floor((height - size) / 2),
    size,
  };
}

export function outputPath(
  sourcePath: string,
  outputDir: string | null,
  size: IcoSize,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  const stem = fileStem(sourcePath);
  return joinPath(dir, `${stem}-${size}x${size}.ico`);
}

export interface OutputPreviewRow {
  size: IcoSize;
  path: string;
  status: "ready" | "exists";
}

export function buildOutputPreview(
  sourcePath: string,
  outputDir: string | null,
  sizes: IcoSize[],
  existsMap: Map<string, boolean>,
): OutputPreviewRow[] {
  return sizes.map((size) => {
    const path = outputPath(sourcePath, outputDir, size);
    return {
      size,
      path,
      status: existsMap.get(path) ? "exists" : "ready",
    };
  });
}
