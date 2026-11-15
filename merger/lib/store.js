/**
 * تخزين الـ Blobs في Turso — كل ملف يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)
 * ويُقرأ تدفقيًا بصفحات من 8 صفوف (16MB لكل صفحة).
 */
const dbmod = require("./db");

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB لكل صف
const PAGE_ROWS = 8; // 16MB لكل صفحة قراءة

/** كتابة Buffer كامل في جدول chunks — مع ضمان وجود الجداول أولًا */
async function writeBlob(table, jobId, data, seqColumn) {
  await dbmod.ensureSchema();
  const client = dbmod.db();
  const chunks = [];
  for (let off = 0; off < data.length; off += CHUNK_SIZE) {
    chunks.push(data.subarray(off, off + CHUNK_SIZE));
  }
  const rows = [];
  for (let i = 0; i < chunks.length; i++) {
    if (seqColumn === undefined) {
      // output_chunks: (job_id, chunk, data)
      rows.push({ sql: `INSERT INTO ${table} (job_id, chunk, data) VALUES (?, ?, ?)`, args: [jobId, i, chunks[i]] });
    } else {
      // source_chunks: (job_id, seq, chunk, data) — رفع أجزاء منفردة أو كاملة
      rows.push({ sql: `INSERT INTO ${table} (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`, args: [jobId, seqColumn, i, chunks[i]] });
    }
  }
  // دفعات صغيرة لتجنب تجاوز حدود الطلب
  for (let i = 0; i < rows.length; i += 10) {
    await client.batch(rows.slice(i, i + 10), "write");
  }
  return chunks.length;
}

/** حذف صفوف blob لمهمة (اختياريًا لمصدر معين) */
async function deleteBlob(table, jobId, seq) {
  const client = dbmod.db();
  if (seq === undefined) {
    await client.execute({ sql: `DELETE FROM ${table} WHERE job_id = ?`, args: [jobId] });
  } else {
    await client.execute({ sql: `DELETE FROM ${table} WHERE job_id = ? AND seq = ?`, args: [jobId, seq] });
  }
}

/**
 * قراءة البايتات المطلوبة فقط [start, end] من blob مخزن — تدفقيًا بالصفحات.
 * تعيد Buffer بالحجم المطلوب بالضبط (أو ما تبقى).
 */
async function readBlobRange(table, jobId, start, end, seq) {
  await dbmod.ensureSchema();
  const client = dbmod.db();
  const out = [];

  // التنفيذ الفعلي: مؤشر chunk متسلسل — أزاحة بالبايت داخل الصفحة الحالية،
  // والأداء مقبول لأن حجم الصف موحد (2MB) إلا الأخير.
  let chunkIndex = 0;
  let offsetInsidePage = start;
  let remaining = end - start + 1;
  let done = false;

  while (!done) {
    const page = await client.execute({
      sql: seq === undefined
        ? `SELECT chunk, data FROM ${table} WHERE job_id = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${PAGE_ROWS}`
        : `SELECT chunk, data FROM ${table} WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${PAGE_ROWS}`,
      args: seq === undefined ? [jobId, chunkIndex] : [jobId, seq, chunkIndex],
    });
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      chunkIndex = Number(row.chunk) + 1;
      const buf = Buffer.from(row.data); // BLOB → Buffer
      if (offsetInsidePage >= buf.length) {
        offsetInsidePage -= buf.length;
        continue;
      }
      const take = Math.min(buf.length - offsetInsidePage, remaining);
      out.push(buf.subarray(offsetInsidePage, offsetInsidePage + take));
      remaining -= take;
      offsetInsidePage = 0;
      if (remaining <= 0) {
        done = true;
        break;
      }
    }
    if (page.rows.length < PAGE_ROWS) break;
  }
  return Buffer.concat(out);
}

module.exports = { writeBlob, deleteBlob, readBlobRange, CHUNK_SIZE, PAGE_ROWS };
