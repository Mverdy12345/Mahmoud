/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP
 * قرار: عميل واحد معاد استخدامه + ensureSchema تُنشئ الجداول عند أول وصول
 * (بدون أداة migrations) للتوافق الكامل مع بيئة Vercel الـ serverless.
 */
import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

/** عميل Turso واحد عبر HTTP (إلزامي للتوافق مع Vercel — لا ملفات SQLite محلية) */
export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة"
      );
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول — آمنة للاستدعاء المتكرر (تُنفَّذ مرة واحدة لكل نسخة دالة) */
export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getTurso();
      await db.batch(
        [
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
          `CREATE INDEX IF NOT EXISTS idx_keys_pool ON api_keys(provider, status, created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`,
        ],
        "write"
      );
    })().catch((e) => {
      // إعادة تفعيل المحاولة عند الخطأ التالي بدل تخزين وعد فاشل نهائيًا
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/** فحص صحة الاتصال بقاعدة Turso */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

/* ----------------------------- أنواع مشتركة ----------------------------- */

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/* --------------------------- عمليات المهام --------------------------- */

export async function insertTask(
  task: Omit<TaskRow, "created_at" | "updated_at" | "completed_at"> & {
    created_at?: string;
    updated_at?: string;
    completed_at?: string | null;
  }
): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt,
            params_json, status, progress, result_urls_json, error_message, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      task.id,
      task.provider ?? null,
      task.provider_task_id ?? null,
      task.key_id ?? null,
      task.model,
      task.type,
      task.prompt ?? "",
      task.params_json ?? "{}",
      task.status,
      task.progress ?? 0,
      task.result_urls_json ?? null,
      task.error_message ?? null,
      task.attempts_json ?? "[]",
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1",
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToTask(r.rows[0]);
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    provider: (row.provider as string) ?? null,
    provider_task_id: (row.provider_task_id as string) ?? null,
    key_id: (row.key_id as string) ?? null,
    model: String(row.model),
    type: row.type as TaskRow["type"],
    prompt: (row.prompt as string) ?? "",
    params_json: (row.params_json as string) ?? "{}",
    status: row.status as TaskRow["status"],
    progress: Number(row.progress ?? 0),
    result_urls_json: (row.result_urls_json as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    attempts_json: (row.attempts_json as string) ?? "[]",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: (row.completed_at as string) ?? null,
  };
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  newAttempt?: AttemptRecord; // يُلحق بسجل المحاولات دائمًا
}

/** تحديث جزئي للمهمة: يضيف المحاولة لسجلها ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const current = await getTask(id);
  if (!current) return null;

  let attempts: AttemptRecord[] = [];
  try {
    attempts = JSON.parse(current.attempts_json || "[]");
  } catch {
    attempts = [];
  }
  if (patch.newAttempt) attempts.push(patch.newAttempt);

  // عند الاكتمال أو الفشل: progress نهائي و completed_at
  const progress =
    patch.progress !== undefined
      ? patch.progress
      : patch.status === "completed"
        ? 100
        : current.progress;

  const status = patch.status ?? current.status;
  const completedAt =
    status === "completed" || status === "failed"
      ? new Date().toISOString()
      : current.completed_at;

  await getTurso().execute({
    sql: `UPDATE tasks SET
            provider = ?, provider_task_id = ?, key_id = ?, status = ?, progress = ?,
            result_urls_json = ?, error_message = ?, attempts_json = ?,
            completed_at = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      patch.provider !== undefined ? patch.provider : current.provider,
      patch.provider_task_id !== undefined
        ? patch.provider_task_id
        : current.provider_task_id,
      patch.key_id !== undefined ? patch.key_id : current.key_id,
      status,
      progress,
      patch.result_urls_json !== undefined
        ? patch.result_urls_json
        : current.result_urls_json,
      patch.error_message !== undefined
        ? patch.error_message
        : current.error_message,
      JSON.stringify(attempts),
      completedAt,
      id,
    ],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit = 20,
  filter?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter?.type) {
    clauses.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(limit);
  const r = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args,
  });
  return r.rows.map(rowToTask);
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const r = await getTurso().execute(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/** حذف مهمة (يُستخدم لتنظيف مهام الاختبار) */
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}

/* --------------------------- عمليات المفاتيح --------------------------- */

export async function getKeyPool(
  providers: ("kie" | "cometapi")[]
): Promise<KeyRow[]> {
  await ensureSchema();
  // ترتيب تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin
  const placeholders = providers.map(() => "?").join(",");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map(rowToKey);
}

function rowToKey(row: Record<string, unknown>): KeyRow {
  return {
    id: String(row.id),
    provider: row.provider as KeyRow["provider"],
    label: (row.label as string) ?? "",
    api_key: String(row.api_key),
    status: (row.status as KeyRow["status"]) ?? "active",
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: (row.last_used_at as string) ?? null,
    last_checked_at: (row.last_checked_at as string) ?? null,
    last_error: (row.last_error as string) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

export async function listAllKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return r.rows.map(rowToKey);
}

export async function insertKey(k: {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label, k.api_key],
  });
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1",
    args: [id],
  });
  return r.rows.length ? rowToKey(r.rows[0]) : null;
}

export async function updateKeyStatus(
  id: string,
  patch: Partial<Pick<KeyRow, "status" | "last_error" | "last_used_at" | "last_checked_at">> & {
    usage_delta?: number;
    success_delta?: number;
    fail_delta?: number;
  }
): Promise<void> {
  await ensureSchema();
  // نقرأ الحالي ثم نطبّق الزيادات — أبسط وأأمن مع libSQL HTTP
  const cur = await getKeyById(id);
  if (!cur) return;
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            status = ?,
            last_error = ?,
            last_used_at = COALESCE(?, last_used_at),
            last_checked_at = COALESCE(?, last_checked_at),
            usage_count = usage_count + ?,
            success_count = success_count + ?,
            fail_count = fail_count + ?
          WHERE id = ?`,
    args: [
      patch.status ?? cur.status,
      patch.last_error !== undefined ? patch.last_error : cur.last_error,
      patch.last_used_at ?? null,
      patch.last_checked_at ?? null,
      patch.usage_delta ?? 0,
      patch.success_delta ?? 0,
      patch.fail_delta ?? 0,
      id,
    ],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}
