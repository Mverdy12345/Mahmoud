/**
 * GET /api/health — حالة السيرفر: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، التوثيق
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ */
async function checkMerger(): Promise<{ base: string | null; healthy: boolean }> {
  const base = process.env.MERGER_API_BASE?.replace(/\/+$/, "") ?? null;
  if (!base || !mergerConfigured()) return { base, healthy: false };
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4000) });
    return { base, healthy: res.ok };
  } catch {
    return { base, healthy: false };
  }
}

export async function GET(): Promise<NextResponse> {
  const database = (await dbHealthy()) ? "turso-connected" : "disconnected";
  const merger = await checkMerger();
  return NextResponse.json({
    ok: database === "turso-connected",
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger,
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
