import { useEffect, useRef, useState } from "react";
import type { CropRect } from "./logic";

interface SquareCropEditorProps {
  imageSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  crop: CropRect;
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

export function SquareCropEditor({
  imageSrc,
  naturalWidth,
  naturalHeight,
  crop,
  onCropChange,
}: SquareCropEditorProps) {
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
    size: crop.size * scale,
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
    const { x, y, size } = cropDisplay;
    const corners: { mode: DragMode; hx: number; hy: number }[] = [
      { mode: "resize-nw", hx: x, hy: y },
      { mode: "resize-ne", hx: x + size, hy: y },
      { mode: "resize-sw", hx: x, hy: y + size },
      { mode: "resize-se", hx: x + size, hy: y + size },
    ];
    for (const corner of corners) {
      if (hitHandle(displayX, displayY, corner.hx, corner.hy)) {
        return corner.mode;
      }
    }
    if (
      displayX >= x &&
      displayX <= x + size &&
      displayY >= y &&
      displayY <= y + size
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
      const maxX = naturalWidth - startCrop.size;
      const maxY = naturalHeight - startCrop.size;
      onCropChange({
        ...startCrop,
        x: clamp(Math.round(startCrop.x + ndx), 0, maxX),
        y: clamp(Math.round(startCrop.y + ndy), 0, maxY),
      });
      return;
    }

    let anchorX = startCrop.x;
    let anchorY = startCrop.y;
    let movingX = startCrop.x + startCrop.size;
    let movingY = startCrop.y + startCrop.size;

    if (mode === "resize-nw") {
      movingX = startCrop.x;
      movingY = startCrop.y;
      anchorX = startCrop.x + startCrop.size;
      anchorY = startCrop.y + startCrop.size;
    } else if (mode === "resize-ne") {
      movingX = startCrop.x + startCrop.size;
      movingY = startCrop.y;
      anchorX = startCrop.x;
      anchorY = startCrop.y + startCrop.size;
    } else if (mode === "resize-sw") {
      movingX = startCrop.x;
      movingY = startCrop.y + startCrop.size;
      anchorX = startCrop.x + startCrop.size;
      anchorY = startCrop.y;
    }

    const pointerX = movingX + ndx;
    const pointerY = movingY + ndy;
    const deltaX = Math.abs(pointerX - anchorX);
    const deltaY = Math.abs(pointerY - anchorY);
    let newSize = Math.round(Math.max(deltaX, deltaY));
    newSize = clamp(newSize, MIN_CROP, Math.min(naturalWidth, naturalHeight));

    let newX = anchorX;
    let newY = anchorY;
    if (pointerX < anchorX) newX = anchorX - newSize;
    if (pointerY < anchorY) newY = anchorY - newSize;

    newX = clamp(newX, 0, naturalWidth - newSize);
    newY = clamp(newY, 0, naturalHeight - newSize);

    onCropChange({ x: newX, y: newY, size: newSize });
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

  const { x, y, size } = cropDisplay;
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const crossLen = Math.min(size * 0.15, 24);

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
            <mask id="crop-mask">
              <rect
                width={displaySize.width}
                height={displaySize.height}
                fill="white"
              />
              <rect x={x} y={y} width={size} height={size} fill="black" />
            </mask>
          </defs>
          <rect
            width={displaySize.width}
            height={displaySize.height}
            fill="rgb(0 0 0 / 0.55)"
            mask="url(#crop-mask)"
          />
          <rect
            x={x}
            y={y}
            width={size}
            height={size}
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
            [x + size, y],
            [x, y + size],
            [x + size, y + size],
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
        Drag inside the square to reposition. Drag corners to resize. The dashed
        crosshair marks the center.
      </p>
    </div>
  );
}
