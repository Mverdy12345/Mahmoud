/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range)
 * ليعمل التقديم/الترجيع في المشغل، و ?download=1 للتحميل المباشر.
 * صفوف الـ Blobs (2MB لكل صف) تُحوَّل إلى stream مع تقليم أول/آخر جزء حسب المدى.
 */
const dbmod = require("../../../lib/db");
const store = require("../../../lib/store");
const { sendError } = require("../../../lib/utils");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET");
  }
  try {
    const jobId = req.query.id;
    const job = await dbmod.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    if (job.status !== "done") {
      return sendError(res, 409, `الناتج غير جاهز — حالة المهمة: ${job.status}`);
    }

    // حجم الناتج الكلي من آخر صف (أو من نتيجة المهمة)
    let totalSize = 0;
    if (job.result_size) {
      totalSize = job.result_size;
    } else {
      const r = await dbmod.db().execute({
        sql: `SELECT COALESCE(SUM(length(data)), 0) AS total FROM output_chunks WHERE job_id = ?`,
        args: [jobId],
      });
      totalSize = Number(r.rows[0]?.total ?? 0);
    }
    if (!totalSize) return sendError(res, 404, "لا يوجد ناتج مخزن");

    const download = req.query.download === "1" || req.query.download === "true";
    const headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="merged-${jobId}.mp4"`;
    }

    // تحليل Range
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = totalSize - 1;
    if (rangeHeader) {
      const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
      if (!m || (m[1] === "" && m[2] === "")) {
        return sendError(res, 416, "مدى Range غير صالح");
      }
      if (m[1] === "") {
        // bytes=-N — آخر N بايت
        const n = Number(m[2]);
        start = Math.max(0, totalSize - n);
        end = totalSize - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? totalSize - 1 : Math.min(Number(m[2]), totalSize - 1);
      }
      if (start > end || start >= totalSize) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        return res.end();
      }
    }

    const buf = await store.readBlobRange("output_chunks", jobId, start, end);
    if (rangeHeader) {
      headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
      headers["Content-Length"] = String(buf.length);
      res.writeHead(206, headers);
    } else {
      headers["Content-Length"] = String(buf.length);
      res.writeHead(200, headers);
    }
    res.end(buf);
  } catch (e) {
    console.error("[video] خطأ:", e);
    return sendError(res, 500, `خطأ داخلي: ${String(e.message ?? e).slice(0, 200)}`);
  }
};
