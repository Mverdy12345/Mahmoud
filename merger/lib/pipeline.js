/**
 * خط الدمج الكامل (منسّق العملية المتزامنة):
 * 1) التحقق من جاهزية كل المصادر (روابط مباشرة / ملفات مرفوعة بالكامل)
 * 2) تجميع المصادر في /tmp (تنزيل الروابط بحد حجم أثناء التدفق + جمع أجزاء المرفوعات)
 * 3) ffmpeg يوحّد ويدمج (تقدم: 0-40 سحب، 40-90 ترميز، 100 اكتمال)
 * 4) تخزين الناتج في Turso كصفوف 2MB + تحديث المهمة done
 * 5) حذف أجزاء المصادر بعد النجاح — الناتج فقط هو المطلوب
 * لا نظام ملفات دائم — /tmp فقط أثناء المعالجة ويُنظَّف في finally.
 */
const fs = require("fs");
const path = require("path");
const dbmod = require("./db");
const store = require("./store");
const { mergeFiles, downloadToTmp, ensureExecutable } = require("./merge");
const { limits } = require("./utils");

async function assembleFileUploads(jobId, sources, tmpPaths, onProgress) {
  // جمع أجزاء كل مصدر مرفوع إلى /tmp بالترتيب
  const client = dbmod.db();
  for (const s of sources) {
    if (s.kind !== "file") continue;
    if (!s.ready && s.received !== s.size) {
      throw new Error(`الملف المرفوع رقم ${s.seq + 1} غير مكتمل (${s.received}/${s.size ?? "?"} بايت)`);
    }
    const tmpPath = tmpPaths[s.seq];
    const fh = fs.createWriteStream(tmpPath);
    let chunkIndex = 0;
    for (;;) {
      const page = await client.execute({
        sql: `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk ASC LIMIT 8`,
        args: [jobId, s.seq, chunkIndex],
      });
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        chunkIndex = Number(row.chunk) + 1;
        const buf = Buffer.from(row.data);
        if (!fh.write(buf)) await new Promise((r) => fh.once("drain", r));
      }
      if (page.rows.length < 8) break;
    }
    await new Promise((r) => fh.end(r));
    const st = fs.statSync(tmpPath);
    if (st.size === 0) throw new Error(`الملف المرفوع رقم ${s.seq + 1} فارغ`);
    if (onProgress) await onProgress();
  }
}

/** التنفيذ الكامل للمهمة — يُستدعى من POST /api/jobs/{id}/process */
async function runJob(jobId, onProgress) {
  const lim = limits();
  const job = await dbmod.getJob(jobId);
  if (!job) throw Object.assign(new Error("المهمة غير موجودة"), { status: 404 });
  if (job.status === "processing") {
    return { already: true };
  }
  if (job.status === "done") {
    // الناتج مخزَّن مسبقًا
    return { alreadyDone: true };
  }

  const sources = await dbmod.listSources(jobId);
  if (sources.length < 2) {
    throw Object.assign(new Error("الدمج يحتاج مصدرَين على الأقل"), { status: 400 });
  }

  await dbmod.updateJob(jobId, { status: "processing", progress: 0, error: null });

  const tmpPaths = {};
  try {
    // 1) تحضير المصادر — تنزيل الروابط (0 → 40)
    let done = 0;
    const bump = async () => {
      done++;
      if (onProgress) await onProgress(Math.round((done / sources.length) * 40));
    };

    for (const s of sources) {
      const p = path.join("/tmp", `job-${jobId}-src-${s.seq}`);
      tmpPaths[s.seq] = p;
      if (s.kind === "url") {
        let bytes = 0;
        const fpath = await downloadToTmp(s.url, lim.sourceMaxBytes, (b) => {
          if (b > bytes + 8 * 1024 * 1024) {
            bytes = b;
            if (onProgress) void onProgress(Math.min(39, Math.round(((done + 0.5) / sources.length) * 40)));
          }
        });
        fs.renameSync(fpath, p);
        await bump();
      } else {
        await bump(); // الملفات تُجمع أدناه معًا
      }
    }
    await assembleFileUploads(jobId, sources, tmpPaths, null);

    // التحقق من المدة الإجمالية
    // (تُفحص مرة أخرى داخل الدمج بعد ffprobe — هنا فحص سريع بالحدود المعلنة)
    // 2) الدمج (40 → 90 داخل mergeFiles)
    const result = await mergeFiles(
      sources.map((s) => tmpPaths[s.seq]),
      onProgress,
      lim.ffmpegPreset
    );

    // 3) التحقق من حدود الناتج
    if (result.size > lim.outputMaxBytes) {
      fs.rmSync(result.path, { force: true });
      throw new Error(`حجم الناتج (${Math.round(result.size / 1024 / 1024)}MB) يتجاوز الحد (${Math.round(lim.outputMaxBytes / 1024 / 1024)}MB)`);
    }
    if (result.duration > lim.maxTotalDurationSec) {
      fs.rmSync(result.path, { force: true });
      throw new Error(`المدة الإجمالية (${Math.round(result.duration)} ثانية) تتجاوز الحد (${lim.maxTotalDurationSec})`);
    }

    // 4) تخزين الناتج في Turso (90 → 99)
    const buf = fs.readFileSync(result.path);
    const rows = await store.writeBlob("output_chunks", jobId, buf);
    if (onProgress) await onProgress(Math.min(99, 90 + Math.round((rows / Math.max(1, rows)) * 9)));

    // 5) حذف أجزاء المصادر بعد النجاح + تحديث المهمة
    await dbmod.db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await dbmod.updateJob(jobId, {
      status: "done",
      progress: 100,
      error: null,
      result_size: result.size,
      result_duration: result.duration,
      result_resolution: result.resolution,
      result_expires_at: expires,
    });
    fs.rmSync(result.path, { force: true });
    return { done: true };
  } catch (e) {
    // تنظيف /tmp عند أي فشل
    for (const p of Object.values(tmpPaths)) fs.rmSync(p, { force: true });
    // فشل واضح — المهمة failed (حتمي: لا إعادة محاولة للفشل المعلن)
    await dbmod.updateJob(jobId, {
      status: "failed",
      progress: job.progress,
      error: String(e.message ?? e).slice(0, 500),
    });
    throw e;
  } finally {
    for (const p of Object.values(tmpPaths)) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* /tmp نظيف دائمًا */
      }
    }
  }
}

module.exports = { runJob };
