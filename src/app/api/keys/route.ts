/**
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
 * POST /api/keys — {provider, api_key, label?} مع رفض التكرار لنفس المزود
 */
import { NextRequest, NextResponse } from "next/server";
import { listAllKeys, insertKey, ensureSchema } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function keyResponse(k: Awaited<ReturnType<typeof listAllKeys>>[number]) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    await ensureSchema();
    const keys = await listAllKeys();
    return NextResponse.json({ ok: true, keys: keys.map(keyResponse) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await ensureSchema();
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = body.provider as "kie" | "cometapi";
    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json({ ok: false, error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    const apiKey = (body.api_key ?? "").trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "مفتاح الـ API مطلوب" }, { status: 400 });
    }
    // رفض التكرار لنفس المزود
    const existing = await listAllKeys();
    if (existing.some((k) => k.provider === provider && k.api_key === apiKey)) {
      return NextResponse.json(
        { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود" },
        { status: 409 }
      );
    }
    const id = crypto.randomUUID();
    await insertKey({
      id,
      provider,
      label: (body.label ?? "").trim().slice(0, 80),
      api_key: apiKey,
    });
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
