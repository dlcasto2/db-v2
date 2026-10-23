/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  env: {
    DEVON_BUILD_ENV: JSON.stringify(
      Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.startsWith("DEVON_")),
      ),
    ),
    DEVON_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
