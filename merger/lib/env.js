/**
 * تحميل متغيرات البيئة يدويًا من .env (بدون أي اعتماديات خارجية)
 * يُستدعى في أول كل دالة — آمن للتكرار.
 */
const fs = require("fs");
const path = require("path");

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let value = m[2];
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
  } catch {
    /* لا ملف .env — نعتمد على بيئة Vercel */
  }
}

module.exports = { loadEnv };
