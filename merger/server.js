/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 *  - يفكّ المسارات الديناميكية ويضعها في req.query (كما تفعل Vercel)
 *  - يخدم ملفات public/ ثابتة
 *  - يستدعي دوال api/ بنفس واجهة Vercel (req, res)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT ?? 3001);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** خريطة المسار → الدالة (نفس بنية Vercel) */
function resolveHandler(pathname) {
  // /api/jobs → api/jobs.js
  if (pathname === "/api/jobs") return { mod: require("./api/jobs"), query: {} };

  // /api/jobs/{id} و /api/jobs/{id}/process و /api/jobs/{id}/video
  const m = pathname.match(/^\/api\/jobs\/([^/]+)(\/process|\/video)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!m[2]) return { mod: require("./api/jobs/[id].js"), query: { id } };
    if (m[2] === "/process") return { mod: require("./api/jobs/[id]/process.js"), query: { id } };
    if (m[2] === "/video") return { mod: require("./api/jobs/[id]/video.js"), query: { id } };
  }

  if (pathname === "/api/upload") return { mod: require("./api/upload"), query: {} };
  if (pathname === "/api/config") return { mod: require("./api/config"), query: {} };
  if (pathname === "/api/cron") return { mod: require("./api/cron"), query: {} };
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = u.pathname;

  // محاكاة Vercel: req.query يتضمن معطيات المسار الديناميكي + الاستعلام
  req.query = {};
  for (const [k, v] of u.searchParams.entries()) req.query[k] = v;

  const handler = resolveHandler(pathname);
  if (handler) {
    Object.assign(req.query, handler.query);
    try {
      await handler.mod(req, res);
    } catch (e) {
      console.error("[dev-server] خطأ غير متوقع:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message ?? e) }));
      }
    }
    return;
  }

  // ملفات ثابتة — / يعني public/index.html
  let file = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
    return res.end(fs.readFileSync(full));
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "المسار غير موجود" }));
});

server.listen(PORT, () => {
  console.log(`[dev-server] خدمة الدمج المحلية تعمل على http://localhost:${PORT}`);
});
