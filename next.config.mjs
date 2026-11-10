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
  // The Claude Agent SDK (app/ai-chat/route.ts) runs the Claude CLI as a
  // subprocess, whose native binary is resolved at runtime rather than
  // imported, so Vercel's build-time file trace misses it unless told.
  // Without this, Devon AI's chat on Vercel fails at the first message with
  // an ENOENT for the CLI binary, not at deploy time.
  //
  // Vercel-only: on EdgeOne, /ai-chat is actually served by agents/ai-chat
  // (its own agent runtime, with EdgeOne's own sandbox tools — see README
  // "Deploying"), so app/ai-chat/route.ts is dead weight there — just a Next
  // route that happens to exist, never the one handling real traffic. Forcing
  // this ~150 MB native CLI binary into .next/standalone for it anyway used
  // to get duplicated again by EdgeOne's own post-build copy step, and the
  // build's small tmpfs ran out of space on that final copy (ENOSPC, ret
  // code 33). Gating it to real Vercel builds removes that copy entirely on
  // EdgeOne, where it was never needed.
  ...(process.env.VERCEL
    ? {
        outputFileTracingIncludes: {
          "app/ai-chat/route": [
            "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**",
            "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/**",
          ],
        },
      }
    : {
        // Same reasoning in reverse: app/ai-chat/route.ts (and the CLI +
        // E2B sandbox it pulls in) is unreachable on EdgeOne, so don't let
        // Next's file trace pull their node_modules into the SSR bundle
        // there either.
        outputFileTracingExcludes: {
          "app/ai-chat/route": [
            "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**",
            "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/**",
            "./node_modules/@e2b/**",
            "./node_modules/e2b/**",
          ],
          // Build-time only (scripts/copy-vendor.mjs copies its browser
          // build into public/vendor/ffmpeg-core/); no server route imports
          // it, so nothing reachable at runtime needs it traced in either.
          "**/*": ["./node_modules/@ffmpeg/core/**"],
        },
      }),
}

export default nextConfig
