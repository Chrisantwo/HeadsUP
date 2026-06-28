/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,   // Leaflet breaks under StrictMode double-mount

  // Proxy /api/* so the frontend always uses relative URLs.
  // Dev  → Flask on localhost:5000
  // Prod → Vercel's internal backend service at /_/backend
  async rewrites() {
    if (process.env.NODE_ENV === 'development') {
      const backend = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'
      return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }]
    }
    return [{ source: '/api/:path*', destination: '/_/backend/api/:path*' }]
  },
}
export default nextConfig
