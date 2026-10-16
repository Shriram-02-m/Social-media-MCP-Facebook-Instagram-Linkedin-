import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["pg"],
  turbopack: {
    // The backend lives in the sibling `social-media-mcp` package and is
    // consumed from its compiled `dist`. Turbopack does not resolve files
    // outside the project root unless the root is widened.
    root: path.resolve(process.cwd(), ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
