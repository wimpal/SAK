import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface DropZoneProps {
  onDrop: (paths: string[]) => void;
  children?: React.ReactNode;
}

export function DropZone({ onDrop, children }: DropZoneProps) {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "enter" || type === "over") {
        setHovering(true);
      } else if (type === "leave") {
        setHovering(false);
      } else if (type === "drop") {
        setHovering(false);
        onDrop(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [onDrop]);

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
        hovering
          ? "border-brand bg-brand/10 text-brand-soft"
          : "border-zinc-700 text-zinc-500"
      }`}
    >
      {children ?? "Drop files here"}
    </div>
  );
}
