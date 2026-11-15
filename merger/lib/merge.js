/**
 * محرك الدمج — ffmpeg + ffprobe (جودة عالية إلزامية)
 *  - ffprobe لكل مصدر: الدقة، المدة، وجود صوت.
 *  - توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *    (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p ثم concat.
 *  - مصدر بلا صوت؟ مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 *  - الترميز: libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 عالي الجودة.
 *  - تقدم الترميز من -progress pipe:1 (out_time_us).
 */
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadEnv } = require("./env");

loadEnv();

/* ثنائيات ffmpeg — مع دعم تجاوز بمتغيرات البيئة للسيرفرات المثبتة مسبقًا */
function staticPaths() {
  let ffmpeg = null;
  let ffprobe = null;
  try {
    ffmpeg = require("ffmpeg-static");
  } catch {
    /* غير مثبت — نعتمد على FFMPEG_PATH */
  }
  try {
    const p = require("ffprobe-static");
    ffprobe = p.path;
  } catch {
    /* غير مثبت */
  }
  return {
    ffmpeg: process.env.FFMPEG_PATH || ffmpeg || "/usr/bin/ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || ffprobe || "/usr/bin/ffprobe",
  };
}

/* نسخ الثنائي إلى /tmp بصلاحية 755 — قد يفقد الاستضافة صلاحية التنفيذ */
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), path.basename(binPath));
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/** فحص مصدر بـ ffprobe: الدقة، المدة، وجود صوت، معدل الإطارات */
async function probeSource(filePath) {
  const { ffprobe } = staticPaths();
  const bin = ensureExecutable(ffprobe);
  const out = await run(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(out);
  const v = (data.streams ?? []).find((s) => s.codec_type === "video");
  const a = (data.streams ?? []).find((s) => s.codec_type === "audio");
  return {
    width: v ? Number(v.width) : 0,
    height: v ? Number(v.height) : 0,
    duration: Number(data.format?.duration ?? v?.duration ?? 0),
    hasAudio: Boolean(a),
    fps: v ? evalFps(v.r_frame_rate ?? "30/1") : 30,
  };
}

function evalFps(rate) {
  const [a, b] = String(rate).split("/").map(Number);
  if (!b || Number.isNaN(a)) return 30;
  return Math.min(60, Math.max(1, a / b));
}

/**
 * الدمج الكامل:
 * inputs: ملفات محلية في /tmp بالترتيب
 * onProgress(p): 0..100 (0-40 سحب/تحضير، 40-90 ترميز، 100 اكتمال)
 * يعيد { path, size, duration, resolution }
 */
async function mergeFiles(inputPaths, onProgress, preset) {
  if (inputPaths.length < 2) throw new Error("الدمج يحتاج مصدرَين على الأقل");

  // 1) فحص كل المصادر (0 → 20)
  const probes = [];
  for (let i = 0; i < inputPaths.length; i++) {
    const p = await probeSource(inputPaths[i]);
    if (!p.width || !p.height) {
      throw new Error(`المصدر رقم ${i + 1} ليس ملف فيديو مقروء`);
    }
    probes.push(p);
    if (onProgress) await onProgress(Math.round(((i + 1) / inputPaths.length) * 20));
  }

  // 2) أكبر دقة بين المدخلات بحد 1920×1080 وأبعاد زوجية
  let maxW = Math.max(...probes.map((p) => p.width));
  let maxH = Math.max(...probes.map((p) => p.height));
  maxW = Math.min(1920, maxW + (maxW % 2));
  maxH = Math.min(1080, maxH + (maxH % 2));
  const totalDuration = probes.reduce((s, p) => s + (p.duration || 0), 0);

  // 3) بناء filter_complex
  const parts = [];
  const labels = [];
  for (let i = 0; i < inputPaths.length; i++) {
    const p = probes[i];
    const safeDur = Math.max(0.1, p.duration || 1);
    let filter = `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
    parts.push(filter + `[v${i}]`);
    if (p.hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت بنفس مدته
      parts.push(
        `aevalsrc=0:d=${safeDur.toFixed(3)},aresample=44100,aformat=channel_layouts=stereo[sa${i}]`
      );
      labels.push(i, "sa" + i);
    }
  }
  // ترتيب وصلات concat: [v0][a0|sa0][v1][a1|sa1]...
  let concatInputs = "";
  for (let i = 0; i < inputPaths.length; i++) {
    const silent = !probes[i].hasAudio;
    concatInputs += `[v${i}][${silent ? "sa" + i : "a" + i}]`;
  }
  parts.push(`${concatInputs}concat=n=${inputPaths.length}:v=1:a=1[v][a]`);
  const filterComplex = parts.join(";");

  // 4) الترميز (40 → 90)
  const { ffmpeg } = staticPaths();
  const bin = ensureExecutable(ffmpeg);
  const outPath = path.join(os.tmpdir(), `merged-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

  const args = ["-y", "-nostats", "-hide_banner"];
  for (const p of inputPaths) args.push("-i", p);
  args.push(
    "-filter_complex", filterComplex,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", preset || process.env.FFMPEG_PRESET || "medium",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    outPath
  );

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    child.stdout.on("data", (d) => {
      // تحليل -progress pipe:1 → out_time_us
      const text = d.toString();
      const m = text.match(/out_time_us=(\d+)/g);
      if (m && onProgress && totalDuration > 0) {
        const last = m[m.length - 1].split("=")[1];
        const sec = Number(last) / 1_000_000;
        const encodePct = Math.min(100, Math.max(0, (sec / totalDuration) * 100));
        const overall = Math.round(40 + encodePct * 0.5); // 40..90
        try {
          const r = onProgress(overall);
          if (r && typeof r.catch === "function") r.catch(() => undefined);
        } catch {
          /* التقدم غير حاسم */
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 40000) stderr = stderr.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg فشل (كود ${code}): ${stderr.slice(-500)}`));
    });
  });
  if (onProgress) await onProgress(90);

  const st = fs.statSync(outPath);
  const finalProbe = await probeSource(outPath);
  return {
    path: outPath,
    size: st.size,
    duration: finalProbe.duration,
    resolution: `${finalProbe.width}x${finalProbe.height}`,
  };
}

/** تنزيل مصدر URL إلى /tmp مع فرض حد الحجم بالبايتات أثناء التدفق */
async function downloadToTmp(url, maxBytes, onBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len && len > maxBytes) {
    throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  const tmpPath = path.join(os.tmpdir(), `src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fh = fs.createWriteStream(tmpPath);
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > maxBytes) {
      fh.destroy();
      fs.rmSync(tmpPath, { force: true });
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }
    if (onBytes) onBytes(received);
    if (!fh.write(chunk)) {
      await new Promise((r) => fh.once("drain", r));
    }
  }
  await new Promise((r) => fh.end(r));
  return tmpPath;
}

module.exports = { mergeFiles, probeSource, downloadToTmp, ensureExecutable, staticPaths };
