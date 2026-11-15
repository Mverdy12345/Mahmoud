/**
 * POST /api/jobs — إنشاء مهمة دمج
 * يقبل {"videos":["رابط1","رابط2"]} أو
 * {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {jobId, status, statusUrl, processUrl, expiresAt, uploads?[]}
 */
const dbmod = require("../lib/db");
const store = require("../lib/store");
const { limits, sendJson, sendError, baseOrigin, newId, expiresAt24h, isHttpUrl, readJsonBody } = require("../lib/utils");

module.exports = async (req, res) => {
  try {
    const lim = limits();

    // تنظيف كسول للمهام المنتهية عند كل طلب إنشاء
    void dbmod.cleanupExpired();

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }
    if (req.method !== "POST") {
      return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendError(res, 400, e.message === "حجم الطلب كبير جدًا" ? e.message : "JSON تالف — تحقق من صيغة الطلب");
    }

    // توحيد المدخلات
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: "url", url: String(u) }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => ({
        kind: s.kind === "file" ? "file" : "url",
        url: s.kind === "file" ? undefined : String(s.url ?? ""),
        name: s.name,
        size: s.size ? Number(s.size) : undefined,
        mime: s.mime,
      }));
    } else {
      return sendError(res, 400, 'المطلوب مصفوفة "videos" من الروابط أو "sources" من المصادر');
    }

    if (sources.length < 1) {
      return sendError(res, 400, "أضف رابطًا واحدًا على الأقل (الدمج نفسه يحتاج مقطعَين على الأقل)");
    }
    if (sources.length > lim.maxSources) {
      return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${lim.maxSources}`);
    }
    if (sources.length < 2) {
      return sendError(res, 400, "الدمج يحتاج مقطعَين على الأقل");
    }

    // التحقق من الروابط
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s.kind === "url") {
        if (!isHttpUrl(s.url)) {
          return sendError(res, 400, `الرابط رقم ${i + 1} غير صالح — يجب أن يكون رابطًا مباشرًا عامًا http/https`);
        }
        if (s.size && s.size > lim.sourceMaxBytes) {
          return sendError(res, 413, `حجم المصدر رقم ${i + 1} يتجاوز الحد (${Math.round(lim.sourceMaxBytes / 1024 / 1024)}MB)`);
        }
      }
    }

    const jobId = newId();
    await dbmod.ensureSchema();
    await dbmod.insertJob({
      id: jobId,
      status: sources.some((s) => s.kind === "file") ? "uploading" : "queued",
      progress: 0,
      sources_json: JSON.stringify(sources),
      expires_at: expiresAt24h(),
    });
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      await dbmod.insertSource({
        job_id: jobId,
        seq: i,
        kind: s.kind,
        name: s.name ?? null,
        url: s.url ?? null,
        size: s.size ?? null,
        mime: s.mime ?? null,
        received: 0,
        ready: 0,
      });
    }

    const base = baseOrigin(req);
    const response = {
      jobId,
      status: sources.some((s) => s.kind === "file") ? "uploading" : "queued",
      statusUrl: `${base}/api/jobs/${jobId}`,
      processUrl: `${base}/api/jobs/${jobId}/process`,
      expiresAt: expiresAt24h(),
    };

    // إن وُجدت ملفات يرجع uploads[] برابط رفع لكل مصدر + uploadChunkBytes
    if (sources.some((s) => s.kind === "file")) {
      response.uploads = sources.map((s, i) => ({
        seq: i,
        uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}&chunk={chunk}`,
        uploadChunkBytes: 4 * 1024 * 1024,
      }));
    }

    return sendJson(res, 201, response);
  } catch (e) {
    console.error("[jobs] خطأ:", e);
    return sendError(res, 500, `خطأ داخلي: ${String(e.message ?? e).slice(0, 200)}`);
  }
};
