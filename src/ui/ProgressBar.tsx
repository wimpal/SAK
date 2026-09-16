interface ProgressBarProps {
  /** Progress from 0 to 1 */
  value: number;
  label?: string;
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div>
      {label && (
        <div className="flex justify-between text-xs text-zinc-400 mb-1">
          <span>{label}</span>
          <span>{pct}%</span>
        </div>
      )}
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full bg-brand transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
