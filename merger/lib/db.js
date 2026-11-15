/**
 * طبقة قاعدة البيانات — Turso (libSQL)
 * كل شيء يُخزَّن هنا: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية — التخطيط يُنشأ بـ CREATE TABLE IF NOT EXISTS.
 */
const { createClient } = require("@libsql/client");
const { loadEnv } = require("./env");

let _client = null;
let _schema = null;

function db() {
  loadEnv();
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

async function ensureSchema() {
  if (!_schema) {
    _schema = (async () => {
      await db().batch(
        [
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER DEFAULT 0,
            error TEXT,
            sources_json TEXT,
            result_size INTEGER,
            result_duration REAL,
            result_resolution TEXT,
            result_expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS sources (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            name TEXT,
            url TEXT,
            size INTEGER,
            mime TEXT,
            received INTEGER DEFAULT 0,
            ready INTEGER DEFAULT 0,
            duration REAL,
            width INTEGER,
            height INTEGER,
            has_audio INTEGER DEFAULT 0,
            PRIMARY KEY (job_id, seq)
          )`,
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB,
            PRIMARY KEY (job_id, seq, chunk)
          )`,
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB,
            PRIMARY KEY (job_id, chunk)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs(expires_at)`,
        ],
        "write"
      );
    })().catch((e) => {
      _schema = null;
      throw e;
    });
  }
  return _schema;
}

async function insertJob(job) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [job.id, job.status, job.progress ?? 0, job.sources_json, job.expires_at],
  });
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress ?? 0),
    error: row.error,
    sources_json: row.sources_json,
    result_size: row.result_size === null ? null : Number(row.result_size),
    result_duration: row.result_duration === null ? null : Number(row.result_duration),
    result_resolution: row.result_resolution,
    result_expires_at: row.result_expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

async function updateJob(id, patch) {
  await ensureSchema();
  const cur = await getJob(id);
  if (!cur) return;
  await db().execute({
    sql: `UPDATE jobs SET
            status = ?, progress = ?, error = ?,
            result_size = COALESCE(?, result_size),
            result_duration = COALESCE(?, result_duration),
            result_resolution = COALESCE(?, result_resolution),
            result_expires_at = COALESCE(?, result_expires_at),
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      patch.status ?? cur.status,
      patch.progress !== undefined ? patch.progress : cur.progress,
      patch.error !== undefined ? patch.error : cur.error,
      patch.result_size !== undefined ? patch.result_size : null,
      patch.result_duration !== undefined ? patch.result_duration : null,
      patch.result_resolution !== undefined ? patch.result_resolution : null,
      patch.result_expires_at !== undefined ? patch.result_expires_at : null,
      id,
    ],
  });
}

async function insertSource(s) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO sources (job_id, seq, kind, name, url, size, mime, received, ready)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [s.job_id, s.seq, s.kind, s.name ?? null, s.url ?? null, s.size ?? null, s.mime ?? null, s.received ?? 0, s.ready ?? 0],
  });
}

async function listSources(jobId) {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return r.rows.map((row) => ({
    job_id: row.job_id,
    seq: Number(row.seq),
    kind: row.kind,
    name: row.name,
    url: row.url,
    size: row.size === null ? null : Number(row.size),
    mime: row.mime,
    received: Number(row.received ?? 0),
    ready: Number(row.ready ?? 0),
    duration: row.duration === null ? null : Number(row.duration),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    has_audio: Number(row.has_audio ?? 0),
  }));
}

async function updateSource(jobId, seq, patch) {
  await ensureSchema();
  const rows = await listSources(jobId);
  const cur = rows.find((s) => s.seq === seq);
  if (!cur) return;
  await db().execute({
    sql: `UPDATE sources SET
            received = ?, ready = ?, duration = COALESCE(?, duration),
            width = COALESCE(?, width), height = COALESCE(?, height),
            has_audio = COALESCE(?, has_audio)
          WHERE job_id = ? AND seq = ?`,
    args: [
      patch.received !== undefined ? patch.received : cur.received,
      patch.ready !== undefined ? (patch.ready ? 1 : 0) : cur.ready,
      patch.duration !== undefined ? patch.duration : null,
      patch.width !== undefined ? patch.width : null,
      patch.height !== undefined ? patch.height : null,
      patch.has_audio !== undefined ? (patch.has_audio ? 1 : 0) : null,
      jobId,
      seq,
    ],
  });
}

/* ------------------- تنظيف المهام المنتهية (24 ساعة) ------------------- */

async function deleteJobFully(jobId) {
  await ensureSchema();
  // حذف كل صفوف المهمة في batch واحد
  await db().batch(
    [
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
    ],
    "write"
  );
}

async function listExpiredJobs() {
  await ensureSchema();
  const r = await db().execute(
    "SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= datetime('now') LIMIT 100"
  );
  return r.rows.map((row) => String(row.id));
}

/** تنظيف كسول يُنفَّذ عند كل طلب إنشاء/دمج + نقطة cron */
async function cleanupExpired() {
  let deleted = 0;
  try {
    // تنفيذ دفاعي: مقارنة بالتاريخ في JS بدل SQL لتجنب اختلاف صيغ datetime
    const r = await db().execute(
      "SELECT id, expires_at FROM jobs WHERE expires_at IS NOT NULL LIMIT 200"
    );
    const now = Date.now();
    for (const row of r.rows) {
      const exp = new Date(String(row.expires_at).replace(" ", "T") + (String(row.expires_at).includes("Z") ? "" : "Z")).getTime();
      if (Number.isFinite(exp) && exp <= now) {
        await deleteJobFully(String(row.id));
        deleted++;
      }
    }
  } catch {
    /* التنظيف لا يفشل الطلب */
  }
  return deleted;
}

module.exports = {
  db,
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  insertSource,
  listSources,
  updateSource,
  deleteJobFully,
  cleanupExpired,
};
