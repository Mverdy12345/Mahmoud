/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
 * حد حجم الطلب في Vercel ≈ 4.5MB → أجزاء POST ثنائية بـ Content-Type: application/octet-stream
 * يخزَّن كل جزء في source_chunks بمفتاح مركب (job_id, seq, chunk).
 */
const dbmod = require("../lib/db");
const { sendJson, sendError } = require("../lib/utils");

const CHUNK_LIMIT = 4 * 1024 * 1024; // 4MB

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  }
  try {
    const jobId = req.query.job;
    const seq = Number(req.query.seq);
    const chunk = Number(req.query.chunk);
    if (!jobId || Number.isNaN(seq) || Number.isNaN(chunk) || seq < 0 || chunk < 0) {
      return sendError(res, 400, "معطيات الرفع مطلوبة: job و seq و chunk");
    }

    const job = await dbmod.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    if (job.status === "done" || job.status === "processing") {
      return sendError(res, 409, "المهمة لم تعد تقبل ملفات");
    }

    const sources = await dbmod.listSources(jobId);
    const src = sources.find((s) => s.seq === seq);
    if (!src) return sendError(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") return sendError(res, 400, "هذا المصدر رابط — لا يُرفع عبر هنا");

    // قراءة الجسم الثنائي كاملًا — نستهلكه دائمًا حتى نتجنب RST يلوث اتصال
    // HTTP/1.1 keep-alive المعاد استخدامه (فحص الحد بعد الاستهلاك بحد أقصى للتخلص)
    const parts = [];
    let size = 0;
    let oversize = false;
    for await (const c of req) {
      size += c.length;
      if (size > CHUNK_LIMIT * 8) {
        // خطر كبير جدًا — قطع فوري مقبول هنا (تجاوز 32MB لجزء "بحد 4MB")
        oversize = true;
        break;
      }
      if (size > CHUNK_LIMIT) {
        oversize = true;
        continue; // نستمر بالاستهلاك بدون تخزين — ثم نرد 413
      }
      parts.push(c);
    }
    if (oversize) {
      return sendError(res, 413, `حجم الجزء يتجاوز ${CHUNK_LIMIT / 1024 / 1024}MB`);
    }
    const buf = Buffer.concat(parts);
    if (buf.length === 0) return sendError(res, 400, "جسم الطلب فارغ");

    // فرض حد حجم المصدر الكلي
    const limitsMod = require("../lib/utils");
    const lim = limitsMod.limits();
    const received = src.received + buf.length;
    if (src.size && received > src.size) {
      return sendError(res, 413, `حجم الملف يتجاوز المعلن (${src.size} بايت)`);
    }
    if (received > lim.sourceMaxBytes) {
      return sendError(res, 413, `حجم الملف يتجاوز الحد (${Math.round(lim.sourceMaxBytes / 1024 / 1024)}MB)`);
    }

    // التخزين (استبدال الجزء إن أعيد رفعه بعد فشل)
    await dbmod.db().execute({
      sql: "DELETE FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk = ?",
      args: [jobId, seq, chunk],
    });
    await dbmod.db().execute({
      sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
      args: [jobId, seq, chunk, buf],
    });
    await dbmod.updateSource(jobId, seq, { received });

    return sendJson(res, 200, {
      ok: true,
      seq,
      chunk,
      received,
      size: src.size ?? null,
      complete: src.size ? received >= src.size : undefined,
    });
  } catch (e) {
    console.error("[upload] خطأ:", e);
    return sendError(res, 500, `خطأ داخلي: ${String(e.message ?? e).slice(0, 200)}`);
  }
};
