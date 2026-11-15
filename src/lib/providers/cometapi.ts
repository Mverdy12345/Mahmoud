/**
 * مزوّد CometAPI:
 *  - الصور: متزامنة عبر POST /v1/images/generations (متوافق مع OpenAI) تعيد الرابط/b64_json فورًا.
 *  - الفيديو: نقطة مهام غير متزامنة بنمط create/check وفق توثيق api.cometapi.com الحالي.
 * التنفيذ دفاعي: نفكّ الأشكال الشائعة للرد ونعالج url أو b64_json.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, ProviderInput } from "./types";

const COMET_BASE = "https://api.cometapi.com";

async function cometFetch(key: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* الفحص لاحقًا */
  }
  if (!res.ok) {
    const msg =
      (body.error as { message?: string })?.message ||
      (body.message as string) ||
      (body.msg as string) ||
      text.slice(0, 300);
    throw new ProviderError(res.status, msg);
  }
  return body;
}

/** استخراج روابط صور من رد OpenAI-compatible (url أو b64_json) */
function extractImageUrls(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const dataArr = (body.data as Array<Record<string, unknown>>) ?? [];
  for (const item of dataArr) {
    if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
      out.push(item.url);
    } else if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
      // b64 فقط يعني الصورة مضمّنة — لا يمكننا تخزينها كرابط دون تنزيل،
      // لكن قاعدة المشروع "روابط فقط": نتجاهل b64_json ونطلب إعادة المحاولة عبر مزود يعيد روابط.
      continue;
    }
  }
  return out;
}

export const cometAdapter: ProviderAdapter = {
  async createImageSync(key, input: ProviderInput) {
    const p = input.payload as {
      prompt?: string;
      model?: string;
      aspect_ratio?: string;
      resolution?: string;
    };
    const body = await cometFetch(key.api_key, `${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: p.model,
        prompt: p.prompt,
        n: 1,
        // نمرر الحقول المدعومة إن وُجدت — الحقول غير المدعومة يتجاهلها المزود عادةً
        ...(p.aspect_ratio && p.aspect_ratio !== "auto" ? { aspect_ratio: p.aspect_ratio } : {}),
        ...(p.resolution ? { resolution: p.resolution } : {}),
      }),
    });
    const urls = extractImageUrls(body);
    if (urls.length === 0) {
      throw new ProviderError(0, "cometapi: لا روابط صور في الرد (قد تكون b64_json فقط)");
    }
    return { urls };
  },

  async createTask(key, model, input: ProviderInput) {
    // نمط المهام غير المتزامن — نمرر model و input كما هو بنفس نمط createTask
    const body = await cometFetch(key.api_key, `${COMET_BASE}/v1/tasks`, {
      method: "POST",
      body: JSON.stringify({ model, input: input.payload }),
    });
    const taskId =
      (body.taskId as string) ??
      (body.id as string) ??
      (body.data as { taskId?: string; id?: string })?.taskId ??
      (body.data as { id?: string })?.id;
    if (!taskId) {
      throw new ProviderError(0, "cometapi: رد createTask بدون معرّف مهمة");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const body = await cometFetch(key.api_key, `${COMET_BASE}/v1/tasks/${encodeURIComponent(providerTaskId)}`);
    const d = (body.data ?? body) as Record<string, unknown>;
    const status = String(d.status ?? d.state ?? "").toLowerCase();
    const progress = typeof d.progress === "number" ? Math.min(95, Math.round(d.progress)) : undefined;

    const urls: string[] = [];
    const resultUrls = (d.resultUrls ?? d.result_urls ?? d.video_url ?? d.url) as unknown;
    if (typeof resultUrls === "string" && /^https?:\/\//.test(resultUrls)) urls.push(resultUrls);
    if (Array.isArray(resultUrls)) {
      for (const u of resultUrls) if (typeof u === "string" && /^https?:\/\//.test(u)) urls.push(u);
    }

    if (["completed", "success", "succeeded", "done", "finished"].includes(status)) {
      if (urls.length) return { status: "completed", urls, progress: 100 };
      return { status: "failed", error: "cometapi: اكتملت بدون روابط" };
    }
    if (["failed", "error", "cancelled", "fail"].includes(status)) {
      return {
        status: "failed",
        error: String(d.error ?? d.failMsg ?? d.message ?? "cometapi: فشلت المهمة"),
      };
    }
    return { status: "processing", progress };
  },
};
