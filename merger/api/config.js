/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
 */
const { limits, sendJson } = require("../lib/utils");

module.exports = async (req, res) => {
  const lim = limits();
  return sendJson(res, 200, {
    ok: true,
    version: lim.version,
    maxSources: lim.maxSources,
    sourceMaxMb: Math.round(lim.sourceMaxBytes / 1024 / 1024),
    outputMaxMb: Math.round(lim.outputMaxBytes / 1024 / 1024),
    maxTotalDurationSec: lim.maxTotalDurationSec,
    uploadChunkBytes: 4 * 1024 * 1024,
    retentionHours: 24,
  });
};
