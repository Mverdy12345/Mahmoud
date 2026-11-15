/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن) → رابط الفيديو النهائي
 * يرجع مباشرة:
 *   200 {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
 *   202 إن كانت المهمة قيد المعالجة فعله
 *   4xx/5xx {"error":...} للفشل الواضح
 */
const dbmod = require("../../../lib/db");
const { runJob } = require("../../../lib/pipeline");
const { sendJson, sendError, baseOrigin } = require("../../../lib/utils");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  }
  try {
    const jobId = req.query.id;
    if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");

    const job = await dbmod.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status === "failed") {
      return sendError(res, 409, `المهمة فشلت سابقًا ولا يمكن إعادة تنفيذها: ${job.error ?? ""}`);
    }

    // تقدم أولي سريع — السحب والترميز يحدّثان القاعدة مباشرة
    await runJob(jobId, (p) => dbmod.updateJob(jobId, { progress: p }));

    const after = await dbmod.getJob(jobId);
    if (after.status === "done") {
      const base = baseOrigin(req);
      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: after.result_size,
        duration: after.result_duration,
        resolution: after.result_resolution,
        expiresAt: after.result_expires_at,
      });
    }
    return sendJson(res, 202, { jobId, status: after.status, progress: after.progress });
  } catch (e) {
    const status = e.status ?? 500;
    return sendError(res, status, String(e.message ?? e).slice(0, 400));
  }
};
