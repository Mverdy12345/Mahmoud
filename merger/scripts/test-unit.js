/**
 * اختبار وحدات محرك الدمج والتخزين:
 *  1) توليد فيديوهين مختلفي الدقة بـ ffmpeg محليًا
 *  2) دمجهما عبر lib/merge.js والتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل،
 *     المدة ≈ مجموع المدد، وجود الصوت
 *  3) تخزين الناتج في Turso واسترجاعه بمطابقة sha256
 *  4) مسار رفع الأجزاء (source_chunks) وحدود الحجم والحذف الشامل
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message ?? e}`);
    });
}

const { ensureExecutable, staticPaths, mergeFiles, probeSource } = require("../lib/merge");
const store = require("../lib/store");
const dbmod = require("../lib/db");
const { limits } = require("../lib/utils");

function genVideo(outPath, w, h, seconds, withAudio) {
  const { ffmpeg } = staticPaths();
  const bin = ensureExecutable(ffmpeg);
  const args = [
    "-y", "-nostats", "-hide_banner",
    "-f", "lavfi",
    "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
    outPath,
  ];
  execFileSync(bin, args, { timeout: 120000 });
}

async function main() {
  console.log("=== اختبار وحدات خدمة الدمج ===\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
  const v1 = path.join(tmpDir, "v1-640.mp4"); // 640x360 مع صوت
  const v2 = path.join(tmpDir, "v2-854.mp4"); // 854x480 بدون صوت
  genVideo(v1, 640, 360, 5, true);
  genVideo(v2, 854, 480, 4, false);
  console.log("تم توليد مصدرين للاختبار (دقات مختلفة)\n");

  const p1 = await probeSource(v1);
  const p2 = await probeSource(v2);
  console.log(`probe1: ${p1.width}x${p1.height} dur=${p1.duration} audio=${p1.hasAudio}`);
  console.log(`probe2: ${p2.width}x${p2.height} dur=${p2.duration} audio=${p2.hasAudio}\n`);

  const result = await mergeFiles([v1, v2], async () => undefined, "ultrafast");

  await test("اكتمال الدمج وإخراج ملف صالح", async () => {
    if (!fs.existsSync(result.path) || result.size === 0) throw new Error("ملف الناتج مفقود");
  });

  await test("الدقة الناتجة = أكبر دقة مدخل (854x480)", async () => {
    if (result.resolution !== "854x480") {
      throw new Error(`الدقة ${result.resolution} غير متوقعة (المتوقع 854x480)`);
    }
  });

  await test("المدة ≈ مجموع المدد (9 ثوانٍ ±1)", async () => {
    const expected = p1.duration + p2.duration;
    if (Math.abs(result.duration - expected) > 1) {
      throw new Error(`المدة ${result.duration} ≠ ${expected}`);
    }
  });

  await test("وجود مسار صوت في الناتج (مصدر بلا صوت + مصدر بصوت)", async () => {
    const pr = await probeSource(result.path);
    const probeJson = JSON.parse(
      require("child_process").execFileSync(
        ensureExecutable(staticPaths().ffprobe),
        ["-v", "error", "-print_format", "json", "-show_streams", result.path],
        { maxBuffer: 64 * 1024 * 1024 }
      )
    );
    const hasAudio = (probeJson.streams ?? []).some((s) => s.codec_type === "audio");
    if (!hasAudio) throw new Error("لا يوجد مسار صوت في الناتج");
  });

  await test("تخزين Turso واسترجاع بمطابقة sha256", async () => {
    const buf = fs.readFileSync(result.path);
    const jobId = "unittest-" + crypto.randomUUID().slice(0, 8);
    await store.writeBlob("output_chunks", jobId, buf);
    const back = await store.readBlobRange("output_chunks", jobId, 0, buf.length - 1);
    const h1 = crypto.createHash("sha256").update(buf).digest("hex");
    const h2 = crypto.createHash("sha256").update(back).digest("hex");
    if (h1 !== h2) throw new Error("sha256 غير متطابقة");
    // قراءة بمدى وسطي (محاكاة Range 206)
    const mid = await store.readBlobRange("output_chunks", jobId, 1000, 4999);
    if (mid.length !== 4000) throw new Error(`قراءة المدى الوسطي أعادت ${mid.length} بدل 4000`);
    await dbmod.deleteJobFully(jobId);
  });

  await test("مسار رفع الأجزاء: كتابة source_chunks وجمعها بالترتيب", async () => {
    const jobId = "unittest-chunks-" + crypto.randomUUID().slice(0, 8);
    const data = crypto.randomBytes(5 * 1024 * 1024); // 5MB → 3 صفوف 2MB
    await store.writeBlob("source_chunks", jobId, data, 0);
    const back = await store.readBlobRange("source_chunks", jobId, 0, data.length - 1, 0);
    if (crypto.createHash("sha256").update(back).digest("hex") !== crypto.createHash("sha256").update(data).digest("hex")) {
      throw new Error("أجزاء المصدر غير متطابقة بعد الجمع");
    }
    await dbmod.deleteJobFully(jobId);
  });

  await test("حدود الحجم: downloadToTmp يرفض المصدر الأكبر من الحد", async () => {
    // ملف محلي 3MB عبر file:// لا يعمل مع fetch — نستخدم خادمًا مؤقتًا صغيرًا
    const http = require("http");
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": big.length });
      res.end(big);
    });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    try {
      await require("../lib/merge").downloadToTmp(
        `http://127.0.0.1:${port}/big.bin`,
        1 * 1024 * 1024 // حد 1MB أقل من حجم المصدر 3MB
      );
      throw new Error("كان يجب رفض التنزيل");
    } catch (e) {
      if (String(e.message).includes("كان يجب")) throw e;
      // متوقع: رفض بسبب الحجم
      if (!String(e.message).includes("يتجاوز الحد")) throw new Error(`رفض خاطئ: ${e.message}`);
    } finally {
      srv.close();
    }
  });

  await test("الحذف الشامل يحذف كل صفوف المهمة", async () => {
    const jobId = "unittest-del-" + crypto.randomUUID().slice(0, 8);
    await dbmod.insertJob({ id: jobId, status: "queued", progress: 0, sources_json: "[]", expires_at: null });
    await dbmod.insertSource({ job_id: jobId, seq: 0, kind: "file", size: 10, ready: 1 });
    await store.writeBlob("output_chunks", jobId, Buffer.alloc(1024, 1));
    await store.writeBlob("source_chunks", jobId, Buffer.alloc(1024, 2), 0);
    await dbmod.deleteJobFully(jobId);
    const job = await dbmod.getJob(jobId);
    if (job) throw new Error("المهمة ما تزال موجودة");
    const src = await dbmod.db().execute({
      sql: "SELECT COUNT(*) AS n FROM source_chunks WHERE job_id = ?",
      args: [jobId],
    });
    if (Number(src.rows[0].n) !== 0) throw new Error("أجزاء المصدر ما تزال موجودة");
  });

  await test("cleanupExpired يحذف المهام المنتهية", async () => {
    const jobId = "unittest-exp-" + crypto.randomUUID().slice(0, 8);
    await dbmod.insertJob({
      id: jobId,
      status: "done",
      progress: 100,
      sources_json: "[]",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const deleted = await dbmod.cleanupExpired();
    if (!(deleted >= 1)) throw new Error(`حذف ${deleted} فقط`);
    if (await dbmod.getJob(jobId)) throw new Error("المهمة المنتهية ما تزال موجودة");
  });

  // تنظيف مصادر الاختبار والناتج
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(result.path, { force: true });

  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
