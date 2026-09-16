export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

export type OutputFormat = "png" | "jpeg" | "webp";

export const OUTPUT_FORMATS: OutputFormat[] = ["png", "jpeg", "webp"];

export const FORMAT_EXT: Record<OutputFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AspectRatioId = "free" | "1:1" | "4:3" | "3:2" | "16:9" | "9:16";

export interface AspectRatioOption {
  id: AspectRatioId;
  label: string;
  /** width / height; undefined means freeform */
  aspect?: number;
}

export const ASPECT_RATIOS: AspectRatioOption[] = [
  { id: "free", label: "Free" },
  { id: "1:1", label: "1:1", aspect: 1 },
  { id: "4:3", label: "4:3", aspect: 4 / 3 },
  { id: "3:2", label: "3:2", aspect: 3 / 2 },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
  { id: "9:16", label: "9:16", aspect: 9 / 16 },
];

export type SizePresetId =
  | "1920x1080"
  | "1280x720"
  | "1024x1024"
  | "512x512"
  | "256x256";

export interface SizePreset {
  id: SizePresetId;
  label: string;
  width: number;
  height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: "1920x1080", label: "1920×1080", width: 1920, height: 1080 },
  { id: "1280x720", label: "1280×720", width: 1280, height: 720 },
  { id: "1024x1024", label: "1024×1024", width: 1024, height: 1024 },
  { id: "512x512", label: "512×512", width: 512, height: 512 },
  { id: "256x256", label: "256×256", width: 256, height: 256 },
];

const MIN_CROP = 16;

function clampCrop(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getAspectValue(id: AspectRatioId): number | null {
  const option = ASPECT_RATIOS.find((a) => a.id === id);
  return option?.aspect ?? null;
}

/** Largest centered rectangle with the given aspect ratio (width / height). */
export function centeredCropWithAspect(
  imageWidth: number,
  imageHeight: number,
  aspect: number,
): CropRect {
  let cropWidth: number;
  let cropHeight: number;

  if (imageWidth / imageHeight > aspect) {
    cropHeight = imageHeight;
    cropWidth = Math.round(cropHeight * aspect);
  } else {
    cropWidth = imageWidth;
    cropHeight = Math.round(cropWidth / aspect);
  }

  cropWidth = clampCrop(cropWidth, MIN_CROP, imageWidth);
  cropHeight = clampCrop(cropHeight, MIN_CROP, imageHeight);

  return {
    x: Math.floor((imageWidth - cropWidth) / 2),
    y: Math.floor((imageHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

/** Centered crop at fixed dimensions, scaled down if the source is smaller. */
export function centeredCropWithSize(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number,
): CropRect {
  const presetAspect = targetWidth / targetHeight;
  let cropWidth = Math.min(targetWidth, imageWidth);
  let cropHeight = Math.min(targetHeight, imageHeight);

  if (cropWidth / cropHeight > presetAspect) {
    cropWidth = Math.round(cropHeight * presetAspect);
  } else if (cropWidth / cropHeight < presetAspect) {
    cropHeight = Math.round(cropWidth / presetAspect);
  }

  cropWidth = clampCrop(cropWidth, MIN_CROP, imageWidth);
  cropHeight = clampCrop(cropHeight, MIN_CROP, imageHeight);

  return {
    x: Math.floor((imageWidth - cropWidth) / 2),
    y: Math.floor((imageHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * Resize a crop rectangle around an anchored corner while locking aspect.
 * The opposite corner of `mode` stays fixed.
 */
export function resizeCropLocked(
  startCrop: CropRect,
  mode: "resize-nw" | "resize-ne" | "resize-sw" | "resize-se",
  ndx: number,
  ndy: number,
  aspect: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  let anchorX: number;
  let anchorY: number;
  let pointerX: number;
  let pointerY: number;

  switch (mode) {
    case "resize-nw":
      anchorX = startCrop.x + startCrop.width;
      anchorY = startCrop.y + startCrop.height;
      pointerX = startCrop.x + ndx;
      pointerY = startCrop.y + ndy;
      break;
    case "resize-ne":
      anchorX = startCrop.x;
      anchorY = startCrop.y + startCrop.height;
      pointerX = startCrop.x + startCrop.width + ndx;
      pointerY = startCrop.y + ndy;
      break;
    case "resize-sw":
      anchorX = startCrop.x + startCrop.width;
      anchorY = startCrop.y;
      pointerX = startCrop.x + ndx;
      pointerY = startCrop.y + startCrop.height + ndy;
      break;
    case "resize-se":
      anchorX = startCrop.x;
      anchorY = startCrop.y;
      pointerX = startCrop.x + startCrop.width + ndx;
      pointerY = startCrop.y + startCrop.height + ndy;
      break;
  }

  const absDx = Math.abs(pointerX - anchorX);
  const absDy = Math.abs(pointerY - anchorY);

  // Prefer the dominant drag axis when fitting the locked aspect.
  let width: number;
  let height: number;
  if (absDx / aspect >= absDy) {
    width = Math.max(MIN_CROP, absDx);
    height = Math.max(MIN_CROP, width / aspect);
  } else {
    height = Math.max(MIN_CROP, absDy);
    width = Math.max(MIN_CROP, height * aspect);
  }

  // Fit within image bounds from the anchored corner.
  const maxWidth =
    pointerX < anchorX ? anchorX : imageWidth - anchorX;
  const maxHeight =
    pointerY < anchorY ? anchorY : imageHeight - anchorY;

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }

  width = clampCrop(Math.round(width), MIN_CROP, imageWidth);
  height = clampCrop(Math.round(height), MIN_CROP, imageHeight);

  // Re-fit after rounding so aspect stays exact within integer pixels.
  if (Math.abs(width / height - aspect) > 0.01) {
    if (width / aspect <= maxHeight) {
      height = Math.max(MIN_CROP, Math.round(width / aspect));
    } else {
      width = Math.max(MIN_CROP, Math.round(height * aspect));
    }
  }

  let x = pointerX < anchorX ? anchorX - width : anchorX;
  let y = pointerY < anchorY ? anchorY - height : anchorY;

  x = clampCrop(x, 0, imageWidth - width);
  y = clampCrop(y, 0, imageHeight - height);

  return { x, y, width, height };
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

/** Centered rectangle using ~80% of source dimensions. */
export function centeredDefaultCrop(
  width: number,
  height: number,
): CropRect {
  const cropWidth = Math.max(16, Math.round(width * 0.8));
  const cropHeight = Math.max(16, Math.round(height * 0.8));
  return {
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: Math.min(cropWidth, width),
    height: Math.min(cropHeight, height),
  };
}

/** Default output stem for a source image: `<stem>-cropped`. */
export function defaultOutputName(sourcePath: string): string {
  return `${fileStem(sourcePath)}-cropped`;
}

/**
 * Sanitize a user-provided output name to a safe filename stem.
 * Strips path separators and trailing extension if it matches a known image ext.
 */
export function sanitizeOutputName(name: string): string {
  let stem = name.trim().replace(/[/\\:*?"<>|]+/g, "").replace(/\.+$/, "");
  const lower = stem.toLowerCase();
  for (const ext of Object.values(FORMAT_EXT)) {
    if (lower.endsWith(`.${ext}`)) {
      stem = stem.slice(0, -(ext.length + 1));
      break;
    }
  }
  return stem.trim() || "cropped";
}

export function isValidOutputName(name: string): boolean {
  return sanitizeOutputName(name).length > 0;
}

export function outputPath(
  sourcePath: string,
  outputDir: string | null,
  format: OutputFormat,
  outputName?: string,
): string {
  const dir = outputDir ?? dirname(sourcePath);
  const stem = sanitizeOutputName(outputName ?? defaultOutputName(sourcePath));
  const ext = FORMAT_EXT[format];
  return joinPath(dir, `${stem}.${ext}`);
}
