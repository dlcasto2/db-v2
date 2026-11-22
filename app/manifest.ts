import type { MetadataRoute } from "next"

// Always the same constant object — no request-specific data — so this is
// safe to mark static everywhere. Required (not just allowed) for the static
// desktop build's `output: "export"`: Next refuses to export manifest.ts
// without it ("export const dynamic" not configured).
export const dynamic = "force-static"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Devon Browser",
    short_name: "Devon",
    description: "A web proxy browser",
    start_url: "/",
    display: "standalone",
    background_color: "#15161b",
    theme_color: "#15161b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  }
}
