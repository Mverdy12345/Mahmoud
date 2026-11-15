/**
 * GET /api/cron — حذف المهام المنتهية (مجدولة يوميًا في vercel.json)
 */
const dbmod = require("../lib/db");
const { sendJson } = require("../lib/utils");

module.exports = async (req, res) => {
  const deleted = await dbmod.cleanupExpired();
  return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
};
