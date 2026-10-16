/** @type {import('next').NextConfig} */
const nextConfig = {
  // Baked into the server code at build time, so the YouTube settings work even on
  // hosts that only give environment variables to the build (they're only used by
  // lib/youtube-server.ts, which never reaches the browser)
  env: {
    // Every DEVON_* variable present at build time, as one JSON string. The server
    // reads real runtime variables first and falls back to these, so settings work
    // whether the host gives variables to the build, to the running site, or both.
    // Only lib/youtube-server.ts reads it, and that never reaches the browser.
    DEVON_BUILD_ENV: JSON.stringify(
      Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("DEVON_"))),
    ),
    DEVON_BUILD_TIME: new Date().toISOString(),
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
