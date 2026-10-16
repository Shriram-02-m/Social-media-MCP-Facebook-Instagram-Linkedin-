import { NextResponse } from "next/server";

import { config } from "@/lib/backend";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    backend: "social-media-mcp",
    metaGraphVersion: config.metaGraphVersion,
    schedulerMode: config.schedulerMode,
  });
}
