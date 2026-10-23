/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: do not add `output: "export"`. Devon is not a static site — the proxy
  // (app/api/proxy), the YouTube routes and the page-safety route all run on the
  // server, and a static export fails on the first one of them. It was added for
  // a GitHub Pages workflow and broke both the build and the EdgeOne deploy; see
  // "GitHub Pages" in README.md for the way to have a github.io address anyway.
  env: {
    // Baked into the server code at build time, so the YouTube settings work even on
    // hosts that only give environment variables to the build (they're only used by
    // lib/youtube-server.ts, which never reaches the browser).
    //
    // Every DEVON_* variable present at build time, as one JSON string. The server
    // reads real runtime variables first and falls back to these, so settings work
    // whether the host gives variables to the build, to the running site, or both.
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
