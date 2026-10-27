"use client"

import { ArrowRight, LayoutGrid } from "lucide-react"
import { APPS, type AppId } from "@/lib/apps"

/** Colors behind each app's icon on its card */
const ART: Record<AppId, string> = {
  ai: "bg-[radial-gradient(circle_at_30%_20%,oklch(0.72_0.16_300/0.55),transparent_60%),radial-gradient(circle_at_80%_90%,oklch(0.6_0.18_272/0.5),transparent_55%)]",
  youtube:
    "bg-[radial-gradient(circle_at_25%_25%,oklch(0.7_0.15_272/0.5),transparent_60%),radial-gradient(circle_at_85%_80%,oklch(0.62_0.2_25/0.35),transparent_55%)]",
  "prompt-gen":
    "bg-[radial-gradient(circle_at_30%_25%,oklch(0.78_0.12_180/0.5),transparent_60%),radial-gradient(circle_at_80%_85%,oklch(0.65_0.13_220/0.45),transparent_55%)]",
  "go-fish":
    "bg-[radial-gradient(circle_at_30%_25%,oklch(0.62_0.14_155/0.5),transparent_60%),radial-gradient(circle_at_80%_85%,oklch(0.45_0.1_155/0.45),transparent_55%)]",
  "html-lab":
    "bg-[radial-gradient(circle_at_30%_25%,oklch(0.72_0.14_220/0.5),transparent_60%),radial-gradient(circle_at_80%_85%,oklch(0.55_0.14_190/0.45),transparent_55%)]",
}

/** The Apps page (devon://apps): Devon's built-in apps, laid out like the Games page */
export function AppsPage({ onOpen }: { onOpen: (url: string) => void }) {
  return (
    <div className="relative h-full w-full overflow-y-auto scrollbar-thin bg-background px-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.7_0.15_272/0.16),transparent)]" />
      <div className="relative mx-auto w-full max-w-4xl py-12">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <LayoutGrid className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
            <p className="text-sm text-muted-foreground">Built into Devon — each one opens in a tab like any site.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((app) => (
            <button
              key={app.id}
              onClick={() => onOpen(app.url)}
              className="group overflow-hidden rounded-2xl bg-toolbar text-left ring-1 ring-border outline-none transition hover:-translate-y-0.5 hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className={`relative grid aspect-video place-items-center overflow-hidden bg-[#161a24] ${ART[app.id]}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={app.icon}
                  alt=""
                  className="size-20 drop-shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition duration-300 group-hover:scale-105"
                />
                <span className="absolute bottom-3 right-3 grid size-9 translate-y-1 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100">
                  <ArrowRight className="size-4" />
                </span>
              </div>
              <div className="p-4">
                <p className="font-medium">{app.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{app.tagline}</p>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
