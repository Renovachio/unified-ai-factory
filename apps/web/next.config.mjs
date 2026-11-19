import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// DISPATCH_STANDALONE=1 produces a self-contained server (node server.js) for the packaged `dispatch` install; the normal CI build is unchanged.
// eslint-disable-next-line no-undef
const standalone = process.env.DISPATCH_STANDALONE === "1";
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true, poweredByHeader: false,
  ...(standalone ? { output: "standalone", outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../..") } : {}),
};
export default nextConfig;
