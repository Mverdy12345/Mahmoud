/**
 * سجل الموديلات — الأسماء القياسية كما يراها عميل MCP + الصيغ البديلة
 * وتجاوز الأسماء بمتغيرات البيئة إن لزم.
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE_MODEL =
  process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL =
  process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL =
  process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL =
  process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE_MODEL,
    aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_IMAGE_MODEL,
      cometapi: COMETAPI_IMAGE_MODEL,
    },
  },
  {
    canonical: KIE_VIDEO_MODEL,
    aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_VIDEO_MODEL,
      cometapi: COMETAPI_VIDEO_MODEL,
    },
  },
];

/** توحيد اسم الموديل عبر الصيغ البديلة (شرطات/نقاط) — غير معروف → null */
export function resolveModel(name?: string): ModelDef | null {
  if (!name) return MODELS[0]; // الافتراضي: موديل الصور الأول
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const target = norm(name);
  for (const m of MODELS) {
    if ([m.canonical, ...m.aliases].map(norm).includes(target)) return m;
  }
  return null;
}

/** ردود الفشل غير القابلة للتبديل تُصاغ عربيًا مرة واحدة */
export const NO_KEYS_MSG = (model: string) =>
  `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
