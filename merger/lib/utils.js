/**
 * أدوات مساعدة عامة — الحدود، الردود، المعرّفات
 */
const { loadEnv } = require("./env");

/** الحدود العامة (قابلة للضبط بمتغيرات البيئة) */
function limits() {
  loadEnv();
  return {
    maxSources: Number(process.env.MAX_SOURCES ?? 10),
    sourceMaxBytes: Number(process.env.SOURCE_MAX_MB ?? 200) * 1024 * 1024,
    outputMaxBytes: Number(process.env.OUTPUT_MAX_MB ?? 150) * 1024 * 1024,
    maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC ?? 600),
    ffmpegPreset: process.env.FFMPEG_PRESET ?? "medium",
    version: "2.0.0",
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** أصل الروابط المطلقة: X-Forwarded-Proto على Vercel، وhttp محليًا */
function baseOrigin(req) {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return `${proto}://${host}`;
}

function newId() {
  // معرّف قصير قابل للقراءة (نفس نمط الخدمة المرجعية)
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 11; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function expiresAt24h() {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && /^https?:\/\//.test(s);
  } catch {
    return false;
  }
}

/** قراءة جسم JSON مع حد حجم */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error("حجم الطلب كبير جدًا");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

module.exports = { limits, sendJson, sendError, baseOrigin, newId, expiresAt24h, isHttpUrl, readJsonBody };
