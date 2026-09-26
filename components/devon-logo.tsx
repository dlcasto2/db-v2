"use client"

import { cn } from "@/lib/utils"

/** The Devon app mark — renders public/icon.svg */
export function DevonMark({ className, title }: { className?: string; title?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icon.svg" alt={title ?? ""} aria-hidden={title ? undefined : true} className={className} draggable={false} />
  )
}

/** Mark + wordmark lockup */
export function DevonLogo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <DevonMark className={cn("size-10", markClassName)} />
      <span className="font-semibold tracking-tight text-foreground">Devon</span>
    </span>
  )
}
