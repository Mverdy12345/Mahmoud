/**
 * نظام المفاتيح المتسلسلة — قلب المشروع
 * 1) الترتيب صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * 2) تصنيف أخطاء المزوّد موحّد يحدد الإجراء (تعطيل/استنزاف/انتقال/توقف).
 * 3) إخفاء المفاتيح إلزامي في كل الاستجابات (maskKey).
 */
import type { KeyRow } from "./turso";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 (أو أول 3 للقصير) */
export function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "••••";
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

/**
 * تصنيف أخطاء المزوّد — الجدول المرجعي:
 *  - exhausted يُفحص قبل 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400
 *  - disabled: 401/403 أو رسائل توثيق
 *  - provider: موديل غير مدعوم → انتقل للتالي
 *  - params: خطأ معطيات → توقف فورًا (تبديل المفاتيح لن يحل المشكلة)
 *  - temporary: 429/5xx/شبكة → انتقل للتالي والمفتاح يبقى سليمًا
 */
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();

  const exhaustedPatterns = [
    "insufficient",
    "quota",
    "balance",
    "credit",
    "out of credits",
    "exhausted",
    "充值",
    "no credit",
    "billing",
  ];
  if (status === 402 || exhaustedPatterns.some((p) => msg.includes(p))) {
    return "exhausted";
  }

  const disabledPatterns = [
    "invalid api key",
    "invalid_api_key",
    "unauthorized",
    "forbidden",
    "authentication",
    "authentication failed",
    "api key",
  ];
  if (status === 401 || status === 403 || disabledPatterns.some((p) => msg.includes(p))) {
    return "disabled";
  }

  if (
    (status === 400 || status === 404 || status === 422) &&
    (msg.includes("model not found") ||
      msg.includes("unsupported model") ||
      msg.includes("no available model") ||
      msg.includes("unknown model"))
  ) {
    return "provider";
  }

  if (status === 400 || status === 422) return "params";

  if (status === 429 || status >= 500 || status === 0) return "temporary";

  // افتراضي: نعامله كمؤقت لنكمل البحث عن مفتاح يعمل بدل التوقف
  return "temporary";
}

/** إجراء التصنيف على المفتاح نفسه: تعطيل/استنزاف/تسجيل خطأ فقط */
export async function applyKeyError(
  key: KeyRow,
  errorClass: ErrorClass,
  message: string
): Promise<void> {
  // استدعاء كسول لتجنب الاستيراد الدائري مع طبقة قاعدة البيانات
  const { updateKeyStatus } = await import("./turso");
  if (errorClass === "disabled") {
    await updateKeyStatus(id(key), {
      status: "disabled",
      last_error: message.slice(0, 500),
      last_checked_at: new Date().toISOString(),
      usage_delta: 1,
      fail_delta: 1,
    });
  } else if (errorClass === "exhausted") {
    // المستنزف يبقى في القاعدة (يُعاد استخدامه بعد الشحن) ولا يُستبعد من القائمة
    await updateKeyStatus(id(key), {
      status: "exhausted",
      last_error: message.slice(0, 500),
      last_checked_at: new Date().toISOString(),
      usage_delta: 1,
      fail_delta: 1,
    });
  } else {
    await updateKeyStatus(id(key), {
      last_error: message.slice(0, 500),
      last_checked_at: new Date().toISOString(),
      usage_delta: 1,
      fail_delta: 1,
    });
  }
}

function id(k: KeyRow): string {
  return k.id;
}

/** تسجيل نجاح على المفتاح */
export async function applyKeySuccess(keyId: string): Promise<void> {
  const { updateKeyStatus } = await import("./turso");
  await updateKeyStatus(keyId, {
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_error: null,
    usage_delta: 1,
    success_delta: 1,
  });
}
