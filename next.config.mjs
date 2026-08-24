/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pg'],
  experimental: {
    // The player dictionary is ~10MB. Nothing that touches it may be bundled
    // for the client; this keeps the boundary loud if someone tries.
    typedRoutes: false,
  },
};

export default nextConfig;
