import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import type { ToolMeta } from "../core/registry";

export function ToolLayout({
  tool,
  children,
}: {
  tool: ToolMeta;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen max-w-4xl mx-auto p-8">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-brand-soft transition-colors"
      >
        <ArrowLeft size={16} />
        All tools
      </Link>

      <header className="mt-6 mb-8 flex items-center gap-4">
        <tool.icon size={32} className="text-brand shrink-0" />
        <div>
          <h1 className="text-2xl font-semibold">{tool.name}</h1>
          <p className="text-zinc-400">{tool.description}</p>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
