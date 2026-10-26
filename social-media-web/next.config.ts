import type { NextConfig } from "next";
import path from "node:path";

// The backend lives in the sibling `social-media-mcp` package, outside this
// project's root. Trace from the monorepo root so the serverless bundle
// mirrors the repository layout.
const monorepoRoot = path.resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["pg"],
  // Next's file tracing defaults to the project directory and misses files
  // outside it. Runtime-read files (see below) must be named explicitly.
  outputFileTracingRoot: monorepoRoot,
  // `database-migrations.ts` reads the backend's `migrations/*.sql` files at
  // runtime via a computed path, which Next's static tracing cannot see
  // (Vercel: `ENOENT ... /var/task/social-media-mcp/migrations/001_...sql`).
  // Trace them into every server entry; the files are tiny SQL scripts.
  outputFileTracingIncludes: {
    "/*": [
      // Runtime-read SQL migration scripts (computed path, invisible to tracing).
      "../social-media-mcp/migrations/*.sql",
      // The compiled backend modules: Turbopack keeps `import.meta.url`
      // pointing at `<root>/social-media-mcp/dist/<file>.js`, and some
      // resolvers expect the file itself to exist at runtime.
      "../social-media-mcp/dist/**/*.js",
    ],
  },
  turbopack: {
    // The backend lives in the sibling `social-media-mcp` package and is
    // consumed from its compiled `dist`. Turbopack does not resolve files
    // outside the project root unless the root is widened.
    // Keep this consistent with `outputFileTracingRoot`.
    root: monorepoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
