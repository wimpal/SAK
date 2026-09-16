import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function FfmpegStatus() {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("ffmpeg_version")
      .then((raw) => {
        const match = raw.match(/ffmpeg version ([0-9.]+)/);
        setVersion(match ? match[1] : raw);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return <p className="text-xs text-red-400">FFmpeg not available — {error}</p>;
  }
  if (!version) {
    return <p className="text-xs text-zinc-600">FFmpeg: checking…</p>;
  }
  return <p className="text-xs text-zinc-600">FFmpeg {version}</p>;
}
