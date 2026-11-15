/**
 * اختبار HTTP كامل ضد خادم التطوير (server.js على المنفذ 3001):
 *  1) إنشاء مهمة من روابط → دمج → بث مع Range 206
 *  2) مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
 *  3) حذف → 404 → JSON تالف → مهمة بلا مصادر → حدود الحجم
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const BASE = process.env.MERGER_TEST_BASE ?? "http://localhost:3001";
const { staticPaths, ensureExecutable } = require("../lib/merge");

let passed = 0;
let failed = 0;
function report(name, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function request(method, urlPath, { body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    const req = http.request(
      {
        method,
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" },
      },
      (res) => {
        (async () => {
          const chunks = [];
          for await (const c of res) chunks.push(c);
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            /* رد ثنائي */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, buf });
        })();
      }
    );
    req.on("error", (e) => {
      console.error(`[trace] فشل الطلب: ${method} ${urlPath} — ${e.message}`);
      reject(e);
    });
    if (body) req.end(body);
    else req.end();
  });
}

/** فيديو اختبار صغير */
function genVideo(outPath, w, h, seconds, withAudio) {
  const { ffmpeg } = staticPaths();
  execFileSync(
    ensureExecutable(ffmpeg),
    [
      "-y", "-nostats", "-hide_banner",
      "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`,
      ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(withAudio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
      outPath,
    ],
    { timeout: 120000 }
  );
}

/** خادم ملفات محلي لخدمة مصدر URL للاختبار */
function startFileServer(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(dir, decodeURIComponent(req.url.replace(/^\//, "")));
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(p).size });
        fs.createReadStream(p).pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ server: srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function main() {
  console.log(`=== اختبار HTTP ضد ${BASE} ===\n`);

  // الفحوصات السريعة أولاً
  const cfg = await request("GET", "/api/config");
  report("GET /api/config يعيد الحدود", cfg.status === 200 && cfg.json?.maxSources === 10);

  const badJson = await request("POST", "/api/jobs", { body: Buffer.from("{not-json"), raw: false });
  report("JSON تالف → 400", badJson.status === 400);

  const empty = await request("POST", "/api/jobs", { body: JSON.stringify({}) });
  report("طلب بلا مصادر → 400", empty.status === 400);

  const one = await request("POST", "/api/jobs", { body: JSON.stringify({ videos: ["https://example.com/a.mp4"] }) });
  report("مصدر واحد → 400 برسالة الدمج يحتاج مقطعين", one.status === 400 && (one.json?.error ?? "").includes("مقطعَين"));

  const eleven = {
    videos: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`),
  };
  const tooMany = await request("POST", "/api/jobs", { body: JSON.stringify(eleven) });
  report("11 مقطعًا → 400 برسالة الحد 10", tooMany.status === 400 && (tooMany.json?.error ?? "").includes("10"));

  const notFound = await request("GET", "/api/jobs/doesnotexist123");
  report("مهمة غير موجودة → 404", notFound.status === 404);

  /* ============ 1) مهمة من روابط: إنشاء → دمج → Range 206 ============ */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const c1 = path.join(tmpDir, "c1.mp4");
  const c2 = path.join(tmpDir, "c2.mp4");
  genVideo(c1, 640, 360, 4, true);
  genVideo(c2, 854, 480, 3, false);

  const fsrv = await startFileServer(tmpDir);
  const u1 = `${fsrv.base}/c1.mp4`;
  const u2 = `${fsrv.base}/c2.mp4`;

  const create = await request("POST", "/api/jobs", { body: JSON.stringify({ videos: [u1, u2] }) });
  const created =
    create.status === 201 &&
    create.json?.jobId &&
    create.json?.statusUrl &&
    create.json?.processUrl &&
    create.json?.expiresAt;
  report("POST /api/jobs (روابط) → 201 مع الحقول الكاملة", Boolean(created), JSON.stringify(create.json ?? {}));
  const jobId = create.json?.jobId;

  report("GET /api/jobs/{id} بعد الإنشاء: queued", (await request("GET", `/api/jobs/${jobId}`)).json?.status === "queued");

  const proc = await request("POST", `/api/jobs/${jobId}/process`);
  report(
    "POST /api/jobs/{id}/process → 200 done مع videoUrl/downloadUrl/size/duration/resolution/expiresAt",
    proc.status === 200 &&
      proc.json?.status === "done" &&
      Boolean(proc.json?.videoUrl) &&
      Boolean(proc.json?.downloadUrl) &&
      proc.json?.size > 0 &&
      proc.json?.duration > 0 &&
      Boolean(proc.json?.resolution) &&
      Boolean(proc.json?.expiresAt),
    JSON.stringify(proc.json ?? {})
  );
  report("رابط الناتج على نطاق الخدمة (بلا نطاقات داخلية)", String(proc.json?.videoUrl ?? "").startsWith(BASE));

  const vid = await request("GET", `/api/jobs/${jobId}/video`);
  report("GET /video بلا Range → 200 mp4 بحجم مطابق", vid.status === 200 && vid.buf.length === proc.json.size, `${vid.buf.length} vs ${proc.json.size}`);

  const half = Math.floor(proc.json.size / 2);
  const ranged = await request("GET", `/api/jobs/${jobId}/video`, {});
  // Range عبر طلب مباشر
  const rangedRes = await new Promise((resolve, reject) => {
    const u = new URL(`${BASE}/api/jobs/${jobId}/video`);
    const req = http.request(
      { method: "GET", host: u.hostname, port: u.port, path: u.pathname, headers: { Range: `bytes=0-${half - 1}` } },
      async (res) => {
        const chunks = [];
        for await (const c of res) chunks.push(c);
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
      }
    );
    req.on("error", reject);
    req.end();
  });
  report(
    "Range 0..نصف → 206 مع Content-Range وبايتات صحيحة",
    rangedRes.status === 206 &&
      rangedRes.headers["content-range"] === `bytes 0-${half - 1}/${proc.json.size}` &&
      rangedRes.buf.length === half,
    `${rangedRes.status} ${rangedRes.headers["content-range"] ?? ""}`
  );

  const dl = await request("GET", `/api/jobs/${jobId}/video?download=1`);
  report("؟download=1 يعيد Content-Disposition", dl.headers["content-disposition"]?.includes("attachment"));

  // تطابق البايتات: أول نصف المخزن يطابق بداية البث الكامل بالضبط
  const firstHalfMatches = rangedRes.buf.equals(vid.buf.subarray(0, half));
  report("أول نصف المخزن مطابق بايتًا لبداية البث الكامل", firstHalfMatches);

  const del = await request("DELETE", `/api/jobs/${jobId}`);
  report("DELETE → 200", del.status === 200);
  const afterDel = await request("GET", `/api/jobs/${jobId}`);
  report("بعد الحذف → 404", afterDel.status === 404);

  /* ============ 2) مهمة مختلطة: رابط + ملف مرفوع بالأجزاء ============ */
  const createMixed = await request("POST", "/api/jobs", {
    body: JSON.stringify({
      sources: [
        { kind: "url", url: u1 },
        { kind: "file", name: "c2.mp4", size: fs.statSync(c2).size, mime: "video/mp4" },
      ],
    }),
  });
  report("مهمة مختلطة → 201 مع uploads[] وuploadChunkBytes", createMixed.status === 201 && Array.isArray(createMixed.json?.uploads) && createMixed.json.uploads?.[1]?.uploadChunkBytes === 4 * 1024 * 1024, JSON.stringify(createMixed.json ?? {}));
  const mixedId = createMixed.json?.jobId;
  const mixedStatus = (await request("GET", `/api/jobs/${mixedId}`)).json?.status;
  report("حالة المهمة مع ملفات = uploading", mixedStatus === "uploading");

  // رفع الملف على أجزاء 4MB (كما تفعل الواجهة) مع إعادة محاولة
  const fileBuf = fs.readFileSync(c2);
  const CHUNK = 4 * 1024 * 1024;
  let uploadedOk = true;
  for (let k = 0, off = 0; off < fileBuf.length; k++, off += CHUNK) {
    const part = fileBuf.subarray(off, Math.min(fileBuf.length, off + CHUNK));
    const r = await request("POST", `/api/upload?job=${mixedId}&seq=1&chunk=${k}`, { body: part, raw: true });
    if (r.status !== 200) {
      uploadedOk = false;
      report(`رفع الجزء ${k}`, false, JSON.stringify(r.json ?? {}));
    }
  }
  report("رفع أجزاء الملف (4MB) → 200 لكل جزء", uploadedOk);

  // جزء أكبر من 4MB → 413 (على المصدر الملفي seq=1)
  const bigPart = Buffer.alloc(5 * 1024 * 1024, 1);
  const bigR = await request("POST", `/api/upload?job=${mixedId}&seq=1&chunk=99`, { body: bigPart, raw: true });
  report("جزء رفع >4MB → 413", bigR.status === 413, `status=${bigR.status}`);

  const mixedProc = await request("POST", `/api/jobs/${mixedId}/process`);
  report(
    "دمج المهمة المختلطة (رابط + ملف مرفوع) → done",
    mixedProc.status === 200 && mixedProc.json?.status === "done",
    JSON.stringify(mixedProc.json ?? {})
  );

  await request("DELETE", `/api/jobs/${mixedId}`);

  fsrv.server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل تشغيل الاختبار:", e);
  process.exit(1);
});
