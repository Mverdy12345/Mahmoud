/**
 * بناء خادم MCP — media-generator-mcp v1.2.0
 * الأدوات الخمس بأوصافها الإنجليزية (يقرأها العميل) ونتائجها بالعربية.
 * الوضع stateless (بدون جلسات) للتوافق الكامل مع بيئة Vercel الـ serverless.
 *
 * قرار: مخططات zod تُعلن كثوابت مستقلة بنوع صريح (z.ZodRawShape) بدل تمريرها
 * مضمنة داخل registerTool — يقطع الاستدلال العميق للأنواع (استهلاك شاذ للذاكرة
 * عند type-check) دون أي تغيير في سلوك المخططات عند التشغيل.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshTask, ParamsError } from "./generation";
import { runMerge } from "./merger";
import { getTask, listRecentTasks } from "./turso";
import { resolveModel } from "./models";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ------------------------- مخططات الأدوات الخمس ------------------------- */

const generateImageSchema: z.ZodRawShape = {
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z
    .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
    .default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z
    .enum(["auto", "transparent", "opaque"])
    .default("auto")
    .describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
};

const generateVideoSchema: z.ZodRawShape = {
  prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().describe("Optional public image URL as the first frame (image-to-video).").optional(),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
};

const mergeVideosSchema: z.ZodRawShape = {
  urls: z.array(z.string()).min(2).max(10)
    .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video.")
    .optional(),
  task_ids: z.array(z.string()).min(2).max(10)
    .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order.")
    .optional(),
  wait_seconds: z.number().int().min(0).max(240).default(60),
};

const getTaskSchema: z.ZodRawShape = {
  task_id: z.string(),
};

const listMediaSchema: z.ZodRawShape = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

/* ------------------------- صياغة الردود العربية ------------------------- */

interface ToolPayload {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // SDK يتطلب index signature في CallToolResult
  [x: string]: unknown;
}

function ok(text: string): ToolPayload {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ToolPayload {
  return { content: [{ type: "text", text }], isError: true };
}

function formatCompleted(task: { type: string; result_urls_json: string | null }): string {
  const urls: string[] = (() => {
    try {
      return JSON.parse(task.result_urls_json ?? "[]") as string[];
    } catch {
      return [];
    }
  })();
  const first = urls[0] ?? "";
  if (task.type === "image") {
    let s = "✅ تم توليد الصورة بنجاح";
    if (first) s += `\n![image](${first})`;
    for (const u of urls) s += `\nالرابط المباشر: ${u}`;
    return s;
  }
  if (task.type === "merge") {
    let s = "✅ تم دمج المقاطع بنجاح";
    for (const u of urls) s += `\nالرابط المباشر: ${u}`;
    s += "\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.";
    return s;
  }
  let s = "✅ تم توليد الفيديو بنجاح";
  for (const u of urls) s += `\nالرابط المباشر: ${u}`;
  return s;
}

function formatProcessing(task: { id: string; progress: number }): string {
  return (
    `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n` +
    `تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`
  );
}

interface ExtraCtx {
  _meta?: Record<string, unknown>;
  sendNotification?: (n: unknown) => Promise<void>;
}

/** إشعار تقدم واحد للعميل عند توفر progressToken — أخطاؤه غير حاسمة */
async function notifyProgress(
  extra: ExtraCtx | undefined,
  progress: number,
  total: number,
  message: string
): Promise<void> {
  const progressToken = (extra?._meta as { progressToken?: string | number } | undefined)?.progressToken;
  if (!progressToken || !extra?.sendNotification) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    });
  } catch {
    /* غير حاسم */
  }
}

/** استدعاء التوليد مع بث إشعارات التقدم للعميل */
async function callGeneration(
  params: Parameters<typeof runGeneration>[0],
  extra: ExtraCtx
): Promise<ToolPayload> {
  try {
    const { task, noKeys } = await runGeneration(params, (p, t, m) => notifyProgress(extra, p, t, m));
    if (noKeys) {
      const model = resolveModel(params.model)?.canonical ?? (params.model as string) ?? "";
      return fail(
        `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`
      );
    }
    if (task.status === "completed") return ok(formatCompleted(task));
    if (task.status === "failed") return fail(task.error_message || "❌ فشلت المهمة لسبب غير معروف");
    return ok(formatProcessing(task));
  } catch (e) {
    if (e instanceof ParamsError) return fail(`❌ ${e.message}`);
    return fail(`❌ حدث خطأ داخلي: ${(e as Error).message.slice(0, 200)}`);
  }
}

/* ----------------------------- بناء الخادم ----------------------------- */

/**
 * توقيع مبسط لـ registerTool: الآلة العامة (generics) للـ SDK تسبب استدلالًا
 * عميقًا بلا داعٍ (TS2589 واستهلاك شاذ للذاكرة) — المخططات نفسها تُحفظ وتُفحص
 * وقت التشغيل عبر zod داخل الـ SDK، فالسلوك الكامل بلا تغيير.
 */
type SimpleToolCb = (args: unknown, extra: unknown) => Promise<ToolPayload> | ToolPayload;
function asRegisterTool(server: McpServer) {
  return server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title?: string; description?: string; inputSchema?: z.ZodRawShape },
    cb: SimpleToolCb
  ) => unknown;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });
  const registerTool = asRegisterTool(server);

  /* 1) generate_image */
  registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). Returns the finished image URL if completed within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: generateImageSchema,
    },
    async (args, extra) => {
      const a = args as {
        prompt: string; model: string; aspect_ratio: string; resolution: string;
        background: string; output_format: string; wait_seconds: number;
      };
      return callGeneration(
        {
          type: "image",
          prompt: a.prompt,
          model: a.model,
          aspect_ratio: a.aspect_ratio,
          resolution: a.resolution,
          background: a.background,
          output_format: a.output_format,
          wait_seconds: a.wait_seconds,
        },
        extra as unknown as ExtraCtx
      );
    }
  );

  /* 2) generate_video */
  registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/sfx/music spoken straight from the prompt, optional image-to-video). Videos take minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: generateVideoSchema,
    },
    async (args, extra) => {
      const a = args as {
        prompt: string; image_url?: string; model: string; aspect_ratio: string;
        resolution: string; enable_audio: boolean; duration: number; wait_seconds: number;
      };
      return callGeneration(
        {
          type: "video",
          prompt: a.prompt,
          image_url: a.image_url,
          model: a.model,
          aspect_ratio: a.aspect_ratio,
          resolution: a.resolution,
          enable_audio: a.enable_audio,
          duration: a.duration,
          wait_seconds: a.wait_seconds,
        },
        extra as unknown as ExtraCtx
      );
    }
  );

  /* 3) merge_videos */
  registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. links returned by generate_video) or 'task_ids' (completed video generation tasks; their result URLs are resolved from the database in this order — ideal right after generating several clips). Merging is usually quick: short wait with live progress, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: mergeVideosSchema,
    },
    async (args, extra) => {
      const a = args as { urls?: string[]; task_ids?: string[]; wait_seconds: number };
      const extraCtx = extra as unknown as ExtraCtx;

      // حلّ روابط task_ids بالترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
      const resolvedUrls: string[] = [];
      const failedDetails: string[] = [];
      for (const tid of a.task_ids ?? []) {
        const t = await getTask(tid);
        if (!t) {
          failedDetails.push(`- ${tid}: غير موجود في قاعدة البيانات`);
          continue;
        }
        if (t.status !== "completed") {
          failedDetails.push(`- ${tid}: الحالة ${t.status}${t.error_message ? ` (${t.error_message})` : ""}`);
          continue;
        }
        try {
          const urls = JSON.parse(t.result_urls_json ?? "[]") as string[];
          if (urls.length > 0) resolvedUrls.push(urls[0]);
          else failedDetails.push(`- ${tid}: مكتملة بدون روابط`);
        } catch {
          failedDetails.push(`- ${tid}: لا روابط صالحة`);
        }
      }
      resolvedUrls.push(...(a.urls ?? []));

      if (resolvedUrls.length < 2) {
        let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
        if (failedDetails.length) msg += "\nتفاصيل المعرّفات:\n" + failedDetails.join("\n");
        return fail(msg);
      }

      const { task, validationError } = await runMerge(resolvedUrls, a.wait_seconds, (p, t, m) =>
        notifyProgress(extraCtx, p, t, m)
      );
      if (validationError) return fail(validationError);
      if (task.status === "completed") return ok(formatCompleted(task));
      if (task.status === "failed") return fail(task.error_message || "❌ فشل الدمج لسبب غير معروف");
      return ok(formatProcessing(task));
    }
  );

  /* 4) get_task */
  registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service while still processing). Poll every ~10 seconds; when completed the result URLs are included — show them to the user and stop polling.",
      inputSchema: getTaskSchema,
    },
    async (args) => {
      const { task_id } = args as { task_id: string };
      const task = await refreshTask(task_id);
      if (!task) return fail(`❌ لا توجد مهمة بالمعرّف: ${task_id}`);
      if (task.status === "completed") return ok(formatCompleted(task));
      if (task.status === "failed") return fail(task.error_message || "❌ فشلت المهمة لسبب غير معروف");
      return ok(formatProcessing(task) + (task.progress ? `\nالتقدم: ${task.progress}%` : ""));
    }
  );

  /* 5) list_media */
  registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the most recent images/videos/merges stored with their result URLs from the database (no re-generation) — for recalling previously generated media.",
      inputSchema: listMediaSchema,
    },
    async (args) => {
      const { type, status, limit } = args as {
        type?: "image" | "video" | "merge";
        status?: "completed" | "failed" | "processing";
        limit?: number;
      };
      const tasks = await listRecentTasks(limit ?? 10, { type, status });
      if (tasks.length === 0) {
        return ok("لا توجد مهام مخزنة بعد بهذه الفلاتر.");
      }
      const lines = tasks.map((t, i) => {
        let urls: string[] = [];
        try {
          urls = JSON.parse(t.result_urls_json ?? "[]") as string[];
        } catch {
          urls = [];
        }
        const head = `${i + 1}. [${t.type}] ${t.status} — ${t.model}${t.prompt ? ` — "${t.prompt.slice(0, 60)}"` : ""}`;
        const idLine = `   task_id: ${t.id} — ${t.created_at}`;
        const urlLines = urls.length
          ? `\n   الروابط:\n${urls.map((u) => `   - ${u}`).join("\n")}`
          : "";
        return head + "\n" + idLine + urlLines;
      });
      return ok(`أحدث ${tasks.length} مهمة مخزنة (من الأحدث):\n\n${lines.join("\n\n")}`);
    }
  );

  return server;
}
