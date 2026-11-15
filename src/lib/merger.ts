/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
 * العنوان من MERGER_API_BASE. القواعد الحتمية:
 *  - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
 *  - أخطاء شبكتنا (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة.
 *  - process يُطلق مرة واحدة فقط (قفل في الذاكرة + علم في params_json).
 */
import { insertTask, updateTask, getTask, type TaskRow } from "./turso";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return /^https?:\/\//.test(MERGER_BASE) && !MERGER_BASE.includes("xxxxxxxx");
}

/** قفل تنفيذ process في الذاكرة — يمنع التزامن مع get_task داخل نفس النسخة */
const processInFlight = new Set<string>();

export const MERGER_LIMITS = { maxVideos: 10 };

class MergerHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 300_000): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${MERGER_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* بعض الردود قد تكون فارغة */
  }
  return { ok: res.ok, status: res.status, body };
}

/** تحليل الحالة دفاعيًا — الأشكال المقاسة: status أو error بدون status */
function parseStatus(body: Record<string, unknown>): "completed" | "failed" | "processing" {
  const s = String(body.status ?? "").toLowerCase();
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(s)) {
    return "completed";
  }
  if (["error", "failed", "failure", "cancelled"].includes(s)) return "failed";
  // قد يرد الجسم فيه error بدون حقل status → فشل فورًا
  if (!s && body.error) return "failed";
  return "processing";
}

/** progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100 */
function normalizeProgress(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const p = n <= 1 ? Math.round(n * 100) : Math.round(n);
  return Math.max(0, Math.min(100, p));
}

/** رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم اضبط رابط البث الافتراضي */
function resultUrl(body: Record<string, unknown>, jobId: string): string {
  const videoUrl = typeof body.videoUrl === "string" && body.videoUrl ? body.videoUrl : null;
  const downloadUrl = typeof body.downloadUrl === "string" && body.downloadUrl ? body.downloadUrl : null;
  return videoUrl ?? downloadUrl ?? `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

/** تحقق صارم من الروابط: ≥2 و ≤10 وكلها http/https مباشرة وعامة */
export function validateMergeUrls(urls: string[]): { ok: boolean; error?: string } {
  if (urls.length < 2) {
    return {
      ok: false,
      error: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    };
  }
  if (urls.length > MERGER_LIMITS.maxVideos) {
    return {
      ok: false,
      error: `❌ أقصى عدد مقاطع للدمج هو ${MERGER_LIMITS.maxVideos} (خدمة الدمج تقبل ${MERGER_LIMITS.maxVideos} مقاطع كحد أقصى).`,
    };
  }
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return { ok: false, error: `❌ رابط غير صالح: ${u.slice(0, 120)}` };
    }
    const host = parsed.hostname.toLowerCase();
    const privateHost =
      host === "localhost" ||
      host.endsWith(".local") ||
      /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.0\.0\.0|^\[?::1\]?$/.test(host) ||
      !/^https?:$/.test(parsed.protocol.replace(":", ""));
    if (privateHost) {
      return { ok: false, error: `❌ يجب أن تكون كل الروابط مباشرة وعامة على الإنترنت: ${u.slice(0, 120)}` };
    }
  }
  return { ok: true };
}

/** إطلاق process مرة واحدة فقط (قفل في الذاكرة + علم دائم في params_json) */
async function fireProcessOnce(task: TaskRow): Promise<void> {
  const jobId = task.provider_task_id;
  if (!jobId) return;
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(task.params_json || "{}");
  } catch {
    params = {};
  }
  if (params.process_fired === true || processInFlight.has(task.id)) return;

  processInFlight.add(task.id);
  params.process_fired = true;
  await markParams(task.id, params);
  // نطلقها خلفيًا وبمرة واحدة فقط — لا ننتظرها (استعلام الحالة هو مصدر الحقيقة)
  void (async () => {
    try {
      const r = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        // خطأ معلن من الخدمة = فشل نهائي فوري (خارج مهل الرد المتزامن الناجح)
        const errMsg = String(r.body.error ?? `خدمة الدمج ردت بحالة ${r.status}`);
        if (r.status >= 400 && !(r.status === 202)) {
          await updateTask(task.id, {
            status: "failed",
            error_message: `❌ فشل الدمج: ${errMsg.slice(0, 300)}`,
          });
        }
      }
    } catch {
      // خطأ شبكتنا = مؤقت — استعلام الحالة يحسم الأمر لاحقًا
    } finally {
      processInFlight.delete(task.id);
    }
  })();
}

/** كتابة params_json مباشرة (تحديث جزئي غير مدعوم في updateTask) */
async function markParams(taskId: string, params: Record<string, unknown>): Promise<void> {
  const { ensureSchema, getTurso } = await import("./turso");
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE tasks SET params_json = ?, updated_at = datetime('now') WHERE id = ?",
    args: [JSON.stringify(params), taskId],
  });
}

/**
 * تدفق runMerge: تسجيل أولًا → POST /api/jobs → process مرة واحدة → استعلام كل 3 ثوانٍ.
 */
export async function runMerge(
  urls: string[],
  waitSeconds = 60,
  onProgress?: (progress: number, total: number, message: string) => Promise<void> | void
): Promise<{ task: TaskRow; validationError?: string }> {
  const wait = Math.max(0, Math.min(240, waitSeconds));

  // سجّل مهمة الدمج أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    provider_task_id: null,
    key_id: null,
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls, process_fired: false }),
    status: "pending",
    progress: 0,
    result_urls_json: null,
    error_message: null,
    attempts_json: "[]",
  });
  let task = (await getTask(taskId))!;

  if (!mergerConfigured()) {
    return {
      task: (await updateTask(taskId, {
        status: "failed",
        error_message: "❌ خدمة الدمج غير مهيأة: اضبط متغير البيئة MERGER_API_BASE على عنوان خدمة الدمج المنشورة.",
      }))!,
      validationError: undefined,
    };
  }

  // إنشاء مهمة الدمج لدى الخدمة — خطأ معلن = فشل نهائي، خطأ شبكة = تبقى بانتظار get_task
  try {
    const r = await mergerFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ videos: urls }),
    }, 60_000);
    if (!r.ok) {
      return {
        task: (await updateTask(taskId, {
          status: "failed",
          error_message: `❌ فشل إنشاء مهمة الدمج: ${String(r.body.error ?? `HTTP ${r.status}`).slice(0, 300)}`,
        }))!,
      };
    }
    const jobId = (r.body.jobId ?? (r.body.data as { jobId?: string })?.jobId) as string | undefined;
    if (!jobId) {
      return {
        task: (await updateTask(taskId, {
          status: "failed",
          error_message: "❌ خدمة الدمج لم تعيد معرّف مهمة",
        }))!,
      };
    }
    task = (await updateTask(taskId, {
      provider_task_id: jobId,
      status: "processing",
      progress: 5,
    }))!;
    await fireProcessOnce(task);
  } catch (e) {
    // خطأ شبكتنا فقط — المهمة تبقى processing وتُستأنف مع كل get_task
    await updateTask(taskId, { error_message: "بانتظار خدمة الدمج…" });
    void e;
    return { task: (await getTask(taskId))! };
  }

  // نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث تقدم وكتابة الحالة فورًا كل مرة
  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    task = (await refreshMergeTask(taskId))!;
    if (task.status === "completed" || task.status === "failed") return { task };
    if (onProgress) {
      const p = Math.min(95, task.progress || 10);
      await onProgress(p, 100, `قيد الدمج… ${p}%`);
    }
  }
  return { task: (await getTask(taskId))! };
}

/** تحديث مهمة الدمج من الخدمة — تُستدعى من runMerge وget_task */
export async function refreshMergeTask(taskId: string): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (!mergerConfigured()) {
    task = (await updateTask(taskId, {
      status: "failed",
      error_message: "❌ خدمة الدمج غير مهيأة: اضبط MERGER_API_BASE.",
    }))!;
    return task;
  }

  // لم تُربط بعد بخدمة الدمج → أعد الإنشاء (بتهدئة عبر updated_at في refreshTask لا هنا)
  if (!task.provider_task_id) {
    try {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(task.params_json || "{}");
      } catch {
        params = {};
      }
      const urls = (params.urls as string[]) ?? [];
      if (urls.length < 2) return task;
      const r = await mergerFetch("/api/jobs", { method: "POST", body: JSON.stringify({ videos: urls }) }, 60_000);
      if (!r.ok) {
        return (
          await updateTask(taskId, {
            status: "failed",
            error_message: `❌ فشل إنشاء مهمة الدمج: ${String(r.body.error ?? `HTTP ${r.status}`).slice(0, 300)}`,
          })
        )!;
      }
      const jobId = (r.body.jobId ?? (r.body.data as { jobId?: string })?.jobId) as string | undefined;
      if (!jobId) return task;
      task = (await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 }))!;
      await fireProcessOnce(task);
    } catch {
      return task; // شبكة — تبقى processing
    }
  }

  const jobId = task.provider_task_id!;
  let r: Awaited<ReturnType<typeof mergerFetch>>;
  try {
    r = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  } catch {
    return task; // شبكتنا — مؤقت، استمر بالاستعلام لاحقًا
  }

  if (r.status === 404) {
    return (
      await updateTask(taskId, {
        status: "failed",
        error_message: "❌ مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      })
    )!;
  }

  if (!r.ok && r.body.error) {
    // خطأ معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري
    return (
      await updateTask(taskId, {
        status: "failed",
        error_message: `❌ فشل الدمج: ${String(r.body.error).slice(0, 300)}`,
      })
    )!;
  }

  const st = parseStatus(r.body);
  if (st === "failed") {
    return (
      await updateTask(taskId, {
        status: "failed",
        error_message: `❌ فشل الدمج: ${String(r.body.error ?? "خدمة الدمج أعلنت الفشل").slice(0, 300)}`,
      })
    )!;
  }
  if (st === "completed") {
    const url = resultUrl(r.body, jobId);
    if (!mergerConfigured() || url) {
      return (
        await updateTask(taskId, {
          status: "completed",
          result_urls_json: JSON.stringify([url]),
        })
      )!;
    }
  }
  // processing — إن كانت المهمة لم تُشغَّل process بعد فنفّذها الآن
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(task.params_json || "{}");
  } catch {
    params = {};
  }
  if (params.process_fired !== true) {
    await fireProcessOnce(task);
  }
  const progress = normalizeProgress(r.body.progress);
  return (
    await updateTask(taskId, {
      progress: progress ?? Math.max(task.progress, 30),
    })
  )!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
