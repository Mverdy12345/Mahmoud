/**
 * GET    /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */
const dbmod = require("../../lib/db");
const { sendJson, sendError, baseOrigin } = require("../../lib/utils");

module.exports = async (req, res) => {
  try {
    const jobId = req.query.id;
    if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");

    const job = await dbmod.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    if (req.method === "DELETE") {
      await dbmod.deleteJobFully(jobId);
      return sendJson(res, 200, { ok: true, deleted: jobId });
    }
    if (req.method !== "GET") {
      return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
    }

    const base = baseOrigin(req);
    const body = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      expiresAt: job.expires_at,
      error: job.error ?? undefined,
    };
    if (job.status === "done") {
      // رابط النتيجة: فضّل videoUrl ثم downloadUrl — وهما بنطاق الخدمة دائمًا
      body.videoUrl = `${base}/api/jobs/${jobId}/video`;
      body.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      body.size = job.result_size;
      body.duration = job.result_duration;
      body.resolution = job.result_resolution;
    }
    return sendJson(res, 200, body);
  } catch (e) {
    console.error("[job] خطأ:", e);
    return sendError(res, 500, `خطأ داخلي: ${String(e.message ?? e).slice(0, 200)}`);
  }
};
