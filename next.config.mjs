/** @type {import('next').NextConfig} */
const nextConfig = {
  // youtubei.js runs YouTube's player script to unlock stream URLs; keep it out of the bundle
  serverExternalPackages: ["youtubei.js"],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
