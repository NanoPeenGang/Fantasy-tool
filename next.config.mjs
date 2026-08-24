/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pg must not be bundled — it loads native-ish internals the bundler mangles.
  // The player dictionary boundary is enforced separately, by `server-only`
  // imports in lib/sleeper/players.ts.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
