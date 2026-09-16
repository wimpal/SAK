import { Link } from "react-router-dom";
import { FfmpegStatus } from "../ui/FfmpegStatus";
import { tools, type ToolCategory } from "./registry";

const categories: ToolCategory[] = ["Video", "Files", "Image", "PDF", "Audio"];

export function Home() {
  return (
    <div className="min-h-screen max-w-5xl mx-auto p-8">
      <header className="mb-10">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 text-white"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z" />
            </svg>
          </span>
          <h1 className="text-3xl font-bold tracking-tight">SAK</h1>
        </div>
        <p className="text-zinc-400 mt-1">Swiss Army Knife — a local toolbox.</p>
      </header>

      {categories.map((category) => (
        <section key={category} className="mb-10">
          <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500 mb-3">
            {category}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {tools
              .filter((t) => t.category === category)
              .map((tool) => (
                <Link
                  key={tool.id}
                  to={tool.path}
                  className="group rounded-xl border border-zinc-800 bg-zinc-900 p-5 hover:border-brand/60 hover:bg-zinc-800/60 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <tool.icon
                      size={24}
                      className="text-zinc-300 group-hover:text-brand transition-colors"
                    />
                    {tool.status === "planned" && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-500">
                        Planned
                      </span>
                    )}
                  </div>
                  <h3 className="mt-3 font-medium">{tool.name}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{tool.description}</p>
                </Link>
              ))}
          </div>
        </section>
      ))}

      <footer className="mt-12 pt-6 border-t border-zinc-800">
        <FfmpegStatus />
      </footer>
    </div>
  );
}
