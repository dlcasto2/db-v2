"use client"

import { useEffect, useState } from "react"
import { Globe } from "lucide-react"
import { cn } from "@/lib/utils"

/** Site icon with a globe fallback when missing or broken */
export function Favicon({ src, className }: { src?: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])

  if (!src || broken) return <Globe className={cn("text-muted-foreground", className)} />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={cn("object-contain", className)} onError={() => setBroken(true)} />
}
