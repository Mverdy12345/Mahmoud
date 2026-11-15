/**
 * منسّق التوليد — runGeneration + refreshTask
 * القواعد الذهبية المطبّقة هنا:
 *  - التبديل التسلسلي الصارم بترتيب المفاتيح مع تسجيل كل محاولة في attempts_json.
 *  - نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا (رسائل عربية محايدة).
 *  - فشل الإنشاء على كل المفاتيح → تبقى المهمة processing وتُعاد مع كل get_task (تهدئة ~45 ثانية).
 *  - فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
 */
import {
  insertTask,
  updateTask,
  getTask,
  getKeyPool,
  type KeyRow,
  type TaskRow,
  type AttemptRecord,
} from "./turso";
import { ProviderError, classifyProviderError, applyKeyError, applyKeySuccess } from "./keys";
import { resolveModel, NO_KEYS_MSG, type MediaType } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometAdapter } from "./providers/cometapi";
import type { ProviderAdapter, ProviderInput } from "./providers/types";

const ADAPTERS: Record<"kie" | "cometapi", ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometAdapter,
};

/** نمط رسائل فشل مفتاح/رصيد في منتصف المهمة → أعد الإنشاء على المفتاح التالي */
const KEY_FAILURE_RE =
  /(insufficient|balance|credit|quota|exhausted|402|401|unauthorized|forbidden|invalid api key|authentication|充值)/i;

export class ParamsError extends Error {}

export interface GenerationParams {
  type: MediaType;
  model?: string;
  prompt?: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
  progressToken?: string | symbol; // من extra._meta لإشعارات التقدم
}

export interface GenerationResult {
  task: TaskRow;
  noKeys?: boolean;
}

/** بناء الحمولة (input) لكل مزود من معطيات الأداة — نحذف قيم auto ليتقرر المزود */
function buildPayload(params: GenerationParams, providerModel: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (params.prompt) payload.prompt = params.prompt;
  if (params.image_url) payload.image_url = params.image_url;
  if (params.aspect_ratio && params.aspect_ratio !== "auto") payload.aspect_ratio = params.aspect_ratio;
  if (params.resolution) payload.resolution = params.resolution;
  if (params.type === "image") {
    if (params.output_format) payload.output_format = params.output_format;
    if (params.background) payload.background = params.background;
  }
  if (params.type === "video") {
    payload.enable_audio = params.enable_audio !== false;
    if (params.duration) payload.duration = params.duration;
  }
  // model المزود يُرسل في الحقل العلوي وليس داخل input
  void providerModel;
  return payload;
}

function attemptRec(
  provider: string,
  key: KeyRow,
  ok: boolean,
  errorClass?: string,
  error?: string
): AttemptRecord {
  return {
    provider,
    keyId: key.id,
    keyLabel: key.label || undefined,
    ok,
    errorClass,
    error: error?.slice(0, 300),
    at: new Date().toISOString(),
  };
}

/** هل يمكن إعادة محاولة الإنشاء الآن؟ (تهدئة ~45 ثانية بين محاولات get_task) */
function cooldownPassed(task: TaskRow, seconds = 45): boolean {
  const last = new Date(task.updated_at + "Z").getTime(); // SQLite datetime('now') = UTC
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= seconds * 1000;
}

/**
 * محاولة ربط المهمة بمزود: تجربة المرشحين بالترتيب بدءًا من بعد آخر مفتاح مستخدم.
 * تعيد المهمة المحدّثة أو null إن فشل الجميع (تبقى processing).
 */
async function attachToProvider(
  task: TaskRow,
  params: GenerationParams,
  startAfterKeyId?: string
): Promise<TaskRow | null> {
  const model = resolveModel(params.model);
  if (!model) throw new ParamsError("موديل غير معروف");
  const candidates = await getKeyPool(model.providers);
  if (candidates.length === 0) return null;

  // ترتيب تسلسلي: نبدأ من المفتاح التالي لآخر محاولة (دوران كامل عبر القائمة مرة واحدة)
  let startIdx = 0;
  if (startAfterKeyId) {
    const i = candidates.findIndex((k) => k.id === startAfterKeyId);
    if (i >= 0) startIdx = (i + 1) % candidates.length;
  }
  const ordered = [...candidates.slice(startIdx), ...candidates.slice(0, startIdx)];

  for (const key of ordered) {
    if (key.status === "disabled") continue; // الاستثناء الوحيد: التعطيل اليدوي
    const adapter = ADAPTERS[key.provider];
    const providerModel = model.providerModel[key.provider];
    const input: ProviderInput = {
      payload: buildPayload(params, providerModel),
    };
    try {
      let providerTaskId: string | null = null;
      // صور متزامنة لدى CometAPI → اكتمال فورًا
      if (params.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, input);
        await applyKeySuccess(key.id);
        return (
          await updateTask(task.id, {
            provider: key.provider,
            key_id: key.id,
            status: "completed",
            result_urls_json: JSON.stringify(urls),
            newAttempt: attemptRec(key.provider, key, true),
          })
        )!;
      }
      const res = await adapter.createTask(key, providerModel, input);
      providerTaskId = res.providerTaskId;
      await applyKeySuccess(key.id);
      return (
        await updateTask(task.id, {
          provider: key.provider,
          provider_task_id: providerTaskId,
          key_id: key.id,
          status: "processing",
          progress: 5,
          error_message: null,
          newAttempt: attemptRec(key.provider, key, true),
        })
      )!;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(0, String((e as Error).message));
      const cls = classifyProviderError(pe.status, pe.message);
      await applyKeyError(key, cls, pe.message);
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        return (
          await updateTask(task.id, {
            status: "failed",
            error_message: `❌ فشلت المهمة: خطأ في معطيات الطلب (${pe.message.slice(0, 200)})`,
            newAttempt: attemptRec(key.provider, key, false, cls, pe.message),
          })
        )!;
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي بصمت
      await updateTask(task.id, {
        newAttempt: attemptRec(key.provider, key, false, cls, pe.message),
      });
    }
  }
  // فشل الجميع — تُحدَّث updated_at فتُعاد التهدئة من جديد مع كل استدعاء
  return null;
}

/** استطلاع واحد للمهمة لدى المزود + معالجة الفشل بالتبديل التسلسلي */
async function pollProviderTask(task: TaskRow): Promise<TaskRow> {
  const model = resolveModel(task.model);
  if (!model || !task.provider_task_id || !task.provider || task.provider === "merger") return task;
  const adapter = ADAPTERS[task.provider as "kie" | "cometapi"];
  if (!adapter) return task;

  const key = await findKey(task.key_id, model.providers);
  if (!key) return task; // لا مفتاح متاح الآن — يُعاد المحاولة لاحقًا

  try {
    const r = await adapter.checkTask(key, task.provider_task_id);
    if (r.status === "completed") {
      await applyKeySuccess(key.id);
      return (
        await updateTask(task.id, {
          status: "completed",
          result_urls_json: JSON.stringify(r.urls ?? []),
          newAttempt: attemptRec(task.provider, key, true),
        })
      )!;
    }
    if (r.status === "failed") {
      const msg = r.error ?? "";
      if (KEY_FAILURE_RE.test(msg)) {
        // فشل مفتاح/رصيد منتصف المهمة → إعادة إنشاء نفس المهمة على المفتاح التالي
        return (
          (await attachToProvider(task, { ...taskParams(task), model: task.model }, task.key_id ?? undefined)) ?? task
        );
      }
      // فشل حقيقي (سياسة/معطيات) → فشل نهائي
      return (
        await updateTask(task.id, {
          status: "failed",
          error_message: `❌ فشلت المهمة: ${msg.slice(0, 300)}`,
          newAttempt: attemptRec(task.provider, key, false, "provider", msg),
        })
      )!;
    }
    // جارية — حدّث التقدم
    return (
      await updateTask(task.id, {
        progress: r.progress ?? task.progress,
      })
    )!;
  } catch (e) {
    // خطأ استعلام مؤقت (شبكة/429/5xx) → نتجاهله ونستمر بالانتظار
    const pe = e instanceof ProviderError ? e : new ProviderError(0, String((e as Error).message));
    const cls = classifyProviderError(pe.status, pe.message);
    await applyKeyError(key, cls, pe.message);
    await updateTask(task.id, { newAttempt: attemptRec(task.provider, key, false, cls, pe.message) });
    return task;
  }
}

async function findKey(keyId: string | null, providers: ("kie" | "cometapi")[]): Promise<KeyRow | null> {
  if (!keyId) return null;
  const { getKeyById } = await import("./turso");
  const k = await getKeyById(keyId);
  if (!k || k.status === "disabled") return null;
  return k;
}

/** استرجاع معطيات الطلب الأصلية لإعادة الإنشاء عند التبديل */
function taskParams(task: TaskRow): GenerationParams {
  try {
    const p = JSON.parse(task.params_json || "{}") as GenerationParams;
    return { ...p, type: task.type };
  } catch {
    return { type: task.type, prompt: task.prompt };
  }
}

/**
 * التدفق الرئيسي لأدوات generate_image / generate_video.
 * نافذة الانتظار تبث تقدمًا حيًا عبر onProgress كل ~3 ثوانٍ.
 */
export async function runGeneration(
  params: GenerationParams,
  onProgress?: (progress: number, total: number, message: string) => Promise<void> | void
): Promise<GenerationResult> {
  const model = resolveModel(params.model);
  if (!model) {
    throw new ParamsError(
      "موديل غير معروف. المتاح: " + "gpt-image-2-6/flare-text-to-image, grok-imagine-video-1-5-preview"
    );
  }
  if (!params.prompt || !params.prompt.trim()) {
    throw new ParamsError("الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا");
  }

  const candidates = await getKeyPool(model.providers);
  if (candidates.length === 0) {
    return { task: {} as TaskRow, noKeys: true }; // يتولى المتصل صياغة رد no_keys
  }

  const waitSeconds = Math.max(0, Math.min(240, params.wait_seconds ?? (params.type === "image" ? 90 : 25)));
  const taskId = crypto.randomUUID();
  const providerModel = model.providerModel[candidates[0].provider];

  // سجّل المهمة قبل أي نداء خارجي — تبقى قابلة للتتبع مهما حدث
  await insertTask({
    id: taskId,
    provider: null,
    provider_task_id: null,
    key_id: null,
    model: model.canonical,
    type: params.type,
    prompt: params.prompt,
    params_json: JSON.stringify(params),
    status: "pending",
    progress: 0,
    result_urls_json: null,
    error_message: null,
    attempts_json: "[]",
  });
  let task = (await getTask(taskId))!;

  // ربط بالمزود (تجربة تسلسلية)
  task = (await attachToProvider(task, params)) ?? task;

  if (task.status === "failed") return { task }; // خطأ معطيات — توقف فورًا
  if (task.status === "completed") return { task };

  if (!task.provider_task_id) {
    // فشل الجميع → تبقى processing برسالة داخلية ولا يُذكر سبب المفاتيح للعميل
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
    task = (await getTask(taskId))!;
    return { task };
  }

  // نافذة الانتظار: استطلاع كل 3 ثوانٍ مع بث تقدم
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    task = await pollProviderTask(task);
    if (task.status === "completed" || task.status === "failed") return { task };
    if (!task.provider_task_id) return { task }; // أُعيد الإنشاء على مفتاح آخر ولم يُربط بعد
    if (onProgress) {
      const p = Math.min(95, task.progress || 10);
      await onProgress(p, 100, `قيد التوليد… ${p}%`);
    }
  }
  // انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  return { task };
}

/**
 * refreshTask — تُستدعى من get_task: تحديث حي من المزود مع نفس منطق التبديل.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;

  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(taskId);
  }

  if (!task.provider_task_id) {
    // بانتظار مفتاح — أعد المحاولة بعد التهدئة فقط
    if (!cooldownPassed(task)) return task;
    const params = taskParams(task);
    task = (await attachToProvider(task, params, task.key_id ?? undefined)) ?? task;
    if (!task.provider_task_id) {
      await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
    }
    return task;
  }

  return pollProviderTask(task);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
