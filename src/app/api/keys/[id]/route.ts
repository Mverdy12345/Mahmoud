/**
 * PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي {action: "disable" | "enable"}
 * DELETE /api/keys/{id} — حذف نهائي
 */
import { NextRequest, NextResponse } from "next/server";
import { getKeyById, updateKeyStatus, deleteKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { action?: string };
    const k = await getKeyById(id);
    if (!k) {
      return NextResponse.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });
    }
    if (body.action === "disable") {
      await updateKeyStatus(id, { status: "disabled" });
    } else if (body.action === "enable") {
      // التنشيط اليدوي يعيد المفتاح للعمل حتى لو كان مستنزفًا (بعد شحن الرصيد مثلًا)
      await updateKeyStatus(id, { status: "active", last_error: null });
    } else {
      return NextResponse.json(
        { ok: false, error: 'الإجراء يجب أن يكون "disable" أو "enable"' },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const k = await getKeyById(id);
    if (!k) {
      return NextResponse.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });
    }
    await deleteKey(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
