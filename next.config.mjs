/** @type {import('next').NextConfig} */
const nextConfig = {
  // Baked into the server code at build time, so the YouTube settings work even on
  // hosts that only give environment variables to the build (they're only used by
  // lib/youtube-server.ts, which never reaches the browser)
  env: {
    DEVON_YT_PROXY: process.env.DEVON_YT_PROXY || "",
    DEVON_YT_CLIENTS: process.env.DEVON_YT_CLIENTS || "",
    DEVON_BUILD_TIME: new Date().toISOString(),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
