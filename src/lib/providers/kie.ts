/**
 * مزوّد kie.ai — Jobs API الموحّد (الأشكال الحقيقية المقاسة من التوثيق الرسمي):
 * POST /api/v1/jobs/createTask  {"model","input"} → {"code":200,"data":{"taskId"}}
 * GET  /api/v1/jobs/recordInfo?taskId= → {"code":200,"data":{"state","resultJson","failMsg","progress"}}
 * ملاحظة: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, ProviderInput } from "./types";

const KIE_BASE = "https://api.kie.ai";

async function kieFetch(key: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // أخطاء الشبكة/المهلة → حالة 0 لتُصنَّف temporary
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* اجعلها فارغة ثم افحص الحالة */
  }
  const code = typeof body.code === "number" ? body.code : res.status;
  const msg = (body.msg as string) || (body.message as string) || text.slice(0, 300);
  if (code !== 200 || !res.ok) {
    throw new ProviderError(code || res.status, msg);
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input: ProviderInput) {
    const body = await kieFetch(key.api_key, `${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      body: JSON.stringify({
        model,
        input: input.payload,
        callBackUrl: input.callBackUrl,
      }),
    });
    const data = body.data as { taskId?: string } | undefined;
    if (!data?.taskId) {
      throw new ProviderError(0, "kie: رد createTask بدون taskId");
    }
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, providerTaskId) {
    const body = await kieFetch(
      key.api_key,
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
      progress?: number;
    };
    const state = (data.state ?? "").toLowerCase();

    if (state === "success") {
      // resultJson نص JSON داخل JSON — نفكّه بأمان
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson ?? "{}") as { resultUrls?: string[] };
        urls = (parsed.resultUrls ?? []).filter(
          (u) => typeof u === "string" && /^https?:\/\//.test(u)
        );
      } catch {
        /* لا روابط قابلة للتحليل */
      }
      if (urls.length === 0) {
        return { status: "failed", error: "kie: المهمة نجحت بدون روابط نتائج" };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      return { status: "failed", error: data.failMsg || "kie: فشلت المهمة لدى المزود" };
    }

    const progress =
      typeof data.progress === "number" && data.progress > 0
        ? Math.min(95, Math.round(data.progress))
        : state === "generating"
          ? 50
          : state === "queuing"
            ? 15
            : 5;
    return { status: "processing", progress };
  },
};
