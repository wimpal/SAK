import { useEffect, useRef, useState } from "react";
import { resizeCropLocked, type CropRect } from "./logic";

interface CropEditorProps {
  imageSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  crop: CropRect;
  /** When set, corner resize locks to this width/height ratio. */
  aspectLock: number | null;
  onCropChange: (crop: CropRect) => void;
}

type DragMode = "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";

const HANDLE_RADIUS = 6;
const MIN_CROP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hitHandle(
  px: number,
  py: number,
  hx: number,
  hy: number,
): boolean {
  const dx = px - hx;
  const dy = py - hy;
  return dx * dx + dy * dy <= HANDLE_RADIUS * HANDLE_RADIUS * 4;
}

export function CropEditor({
  imageSrc,
  naturalWidth,
  naturalHeight,
  crop,
  aspectLock,
  onCropChange,
}: CropEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startCrop: CropRect;
  } | null>(null);

  const scale =
    displaySize.width > 0 ? displaySize.width / naturalWidth : 1;

  const cropDisplay = {
    x: crop.x * scale,
    y: crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function updateSize() {
      const maxW = el!.clientWidth;
      const maxH = 420;
      const ratio = naturalWidth / naturalHeight;
      let width = maxW;
      let height = width / ratio;
      if (height > maxH) {
        height = maxH;
        width = height * ratio;
      }
      setDisplaySize({ width, height });
    }

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [naturalWidth, naturalHeight]);

  function detectMode(displayX: number, displayY: number): DragMode | null {
    const { x, y, width, height } = cropDisplay;
    const corners: { mode: DragMode; hx: number; hy: number }[] = [
      { mode: "resize-nw", hx: x, hy: y },
      { mode: "resize-ne", hx: x + width, hy: y },
      { mode: "resize-sw", hx: x, hy: y + height },
      { mode: "resize-se", hx: x + width, hy: y + height },
    ];
    for (const corner of corners) {
      if (hitHandle(displayX, displayY, corner.hx, corner.hy)) {
        return corner.mode;
      }
    }
    if (
      displayX >= x &&
      displayX <= x + width &&
      displayY >= y &&
      displayY <= y + height
    ) {
      return "move";
    }
    return null;
  }

  function applyDrag(
    mode: DragMode,
    dx: number,
    dy: number,
    startCrop: CropRect,
  ) {
    const ndx = dx / scale;
    const ndy = dy / scale;

    if (mode === "move") {
      const maxX = naturalWidth - startCrop.width;
      const maxY = naturalHeight - startCrop.height;
      onCropChange({
        ...startCrop,
        x: clamp(Math.round(startCrop.x + ndx), 0, maxX),
        y: clamp(Math.round(startCrop.y + ndy), 0, maxY),
      });
      return;
    }

    if (aspectLock !== null && aspectLock > 0) {
      onCropChange(
        resizeCropLocked(
          startCrop,
          mode,
          ndx,
          ndy,
          aspectLock,
          naturalWidth,
          naturalHeight,
        ),
      );
      return;
    }

    let left = startCrop.x;
    let top = startCrop.y;
    let right = startCrop.x + startCrop.width;
    let bottom = startCrop.y + startCrop.height;

    if (mode === "resize-nw") {
      left += ndx;
      top += ndy;
    } else if (mode === "resize-ne") {
      right += ndx;
      top += ndy;
    } else if (mode === "resize-sw") {
      left += ndx;
      bottom += ndy;
    } else {
      right += ndx;
      bottom += ndy;
    }

    if (right - left < MIN_CROP) {
      if (mode === "resize-nw" || mode === "resize-sw") {
        left = right - MIN_CROP;
      } else {
        right = left + MIN_CROP;
      }
    }
    if (bottom - top < MIN_CROP) {
      if (mode === "resize-nw" || mode === "resize-ne") {
        top = bottom - MIN_CROP;
      } else {
        bottom = top + MIN_CROP;
      }
    }

    left = clamp(left, 0, naturalWidth - MIN_CROP);
    top = clamp(top, 0, naturalHeight - MIN_CROP);
    right = clamp(right, left + MIN_CROP, naturalWidth);
    bottom = clamp(bottom, top + MIN_CROP, naturalHeight);

    onCropChange({
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const displayX = e.clientX - rect.left;
    const displayY = e.clientY - rect.top;
    const mode = detectMode(displayX, displayY);
    if (!mode) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    applyDrag(
      drag.mode,
      e.clientX - drag.startX,
      e.clientY - drag.startY,
      drag.startCrop,
    );
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  const { x, y, width, height } = cropDisplay;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const crossLen = Math.min(Math.min(width, height) * 0.15, 24);

  return (
    <div ref={containerRef} className="w-full">
      <div
        className="relative mx-auto select-none touch-none"
        style={{ width: displaySize.width, height: displaySize.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={imageSrc}
          alt="Source"
          draggable={false}
          className="block h-full w-full object-contain"
          width={displaySize.width}
          height={displaySize.height}
        />

        <svg
          className="absolute inset-0 h-full w-full pointer-events-none"
          viewBox={`0 0 ${displaySize.width} ${displaySize.height}`}
        >
          <defs>
            <mask id="crop-mask-freeform">
              <rect
                width={displaySize.width}
                height={displaySize.height}
                fill="white"
              />
              <rect x={x} y={y} width={width} height={height} fill="black" />
            </mask>
          </defs>
          <rect
            width={displaySize.width}
            height={displaySize.height}
            fill="rgb(0 0 0 / 0.55)"
            mask="url(#crop-mask-freeform)"
          />
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth={2}
          />
          <line
            x1={centerX - crossLen}
            y1={centerY}
            x2={centerX + crossLen}
            y2={centerY}
            stroke="var(--color-brand-soft)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          <line
            x1={centerX}
            y1={centerY - crossLen}
            x2={centerX}
            y2={centerY + crossLen}
            stroke="var(--color-brand-soft)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          {[
            [x, y],
            [x + width, y],
            [x, y + height],
            [x + width, y + height],
          ].map(([hx, hy], i) => (
            <circle
              key={i}
              cx={hx}
              cy={hy}
              r={HANDLE_RADIUS}
              fill="var(--color-brand)"
              stroke="white"
              strokeWidth={1.5}
            />
          ))}
        </svg>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Drag inside the rectangle to reposition. Drag corners to resize
        {aspectLock !== null
          ? " (locked to the selected aspect ratio)"
          : ""}
        . The dashed crosshair marks the center.
      </p>
    </div>
  );
}
