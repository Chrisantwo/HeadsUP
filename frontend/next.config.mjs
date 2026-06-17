/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,   // Leaflet breaks under StrictMode double-mount

  // In local dev, proxy /api/* to the Flask server so the frontend can use
  // relative URLs (/api/...) in both dev and production (Vercel).
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return []
    const backend = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
    ]
  },
}
export default nextConfig
