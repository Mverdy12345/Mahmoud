/**
 * GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام (تُستطلم كل ~5 ثوانٍ)
 */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await ensureSchema();
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit") ?? 20)));
    const type = sp.get("type") ?? undefined;
    const status = sp.get("status") ?? undefined;
    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type, status }),
      taskStats(),
    ]);
    return NextResponse.json({
      ok: true,
      stats,
      tasks: tasks.map((t) => {
        let urls: string[] = [];
        try {
          urls = JSON.parse(t.result_urls_json ?? "[]") as string[];
        } catch {
          urls = [];
        }
        let attempts: unknown[] = [];
        try {
          attempts = JSON.parse(t.attempts_json ?? "[]") as unknown[];
        } catch {
          attempts = [];
        }
        return {
          id: t.id,
          type: t.type,
          model: t.model,
          prompt: t.prompt.slice(0, 120),
          status: t.status,
          progress: t.progress,
          urls,
          error_message: t.error_message,
          attempts_count: attempts.length,
          created_at: t.created_at,
          completed_at: t.completed_at,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
