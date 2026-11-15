# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** يجمع ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** مع صوت متزامن أصلي — `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب.

تطبيق **Next.js واحد** فيه جزءان:

- **خادم MCP** على المسار `/mcp` (نقل Streamable HTTP وفق مواصفات MCP عبر SDK الرسمي) يعرض **5 أدوات** يستدعيها نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية RTL** لإدارة مفاتيح API، ومتابعة المهام حية، وعرض إعدادات الربط جاهزة للنسخ لأي عميل MCP.

## القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ نرسل الروابط للمزودين ونخزّن **روابط النتائج فقط** في قاعدة البيانات.
- **تبديل تسلسلي صارم للمفاتيح** بترتيب الإضافة (`created_at ASC, id ASC`) — أول مفتاح أُضيف يُجرَّب أولًا ثم التالي ثم التالي — **ليس** round-robin — مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة (نفس `task_id`).
- نموذج الذكاء الاصطناعي **لا يرى أبدًا** أخطاء المفاتيح أو الرصيد — التبديل صامت تمامًا من وجهة نظره.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`ABCD123••••••••WXYZ`).
- لا أسرار في الكود أو Git — `.env*` مُستثنى منذ أول commit.

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت متزامن، image-to-video اختياري) — `task_id` فورًا ثم تابع بـ `get_task` |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` (روابط مباشرة) أو `task_ids` (مهام مكتملة) — ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يحدّث حيًا من المزود/الخدمة |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد |

أثناء نافذة الانتظار تبث الخدمة **progress notifications** عربية (~كل 3 ثوانٍ) عبر مجرى SSE.

## التشغيل محليًا

```bash
# 1) متغيرات البيئة — أنشئ .env.local
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=<رابط خدمة الدمج المنشورة على Vercel>
# اختياري:
# MCP_ACCESS_TOKEN=        # إن ضُبط يُطلب Bearer token على /mcp
# KIE_IMAGE_MODEL= / KIE_VIDEO_MODEL= / COMETAPI_IMAGE_MODEL= / COMETAPI_VIDEO_MODEL=

# 2) التشغيل
npm install
npm run dev    # http://localhost:3000
```

أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة (`kie.ai` أو `CometAPI`) ثم اربط أي عميل MCP بالرابط `<origin>/mcp`.

## اختبار MCP بالـ curl

```bash
# التهيئة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# استدعاء أداة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```

## النشر على Vercel

1. اربط المستودع بـ Vercel → **Add New Project → Import**.
2. أضف متغيرات البيئة (نفس القيم المحلية):
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان)
   - `MERGER_API_BASE` (رابط نشر خدمة الدمج — انظر `merger/README.md`)
   - `MCP_ACCESS_TOKEN` (اختياري)
3. Deploy — يعمل كل شيء لأن libSQL يتصل عبر HTTP ومسار `/mcp` يدعم الـ streaming، ولا اعتماد على أي ملف محلي.

## المزودون والخدمات

- **kie.ai** — Jobs API الموحد (`/api/v1/jobs/createTask` + `/api/v1/jobs/recordInfo`)، المزود الأساسي للموديلين.
- **CometAPI** — صور متزامنة عبر `/v1/images/generations` (متوافق OpenAI) وفيديو عبر نقطة مهام غير متزامنة.
- **خدمة الدمج** — مشروع منفصل في مجلد `merger/` من نفس المستودع (Video Merger API v2 على Vercel، بلا مفاتيح).

## البنية

```
src/lib/turso.ts          طبقة قاعدة البيانات (tasks + api_keys) وensureSchema
src/lib/keys.ts           المفتاح المتسلسل: التصنيف والإخفاء
src/lib/models.ts         سجل الموديلات والصيغ البديلة
src/lib/providers/        كي + CometAPI adapters
src/lib/generation.ts     runGeneration + refreshTask بالتبديل التسلسلي
src/lib/merger.ts         عميل خدمة الدمج v2 + runMerge
src/lib/mcp-server.ts     خادم MCP بالأدوات الخمس والردود العربية
src/app/mcp/route.ts      المسار /mcp (stateless + SSE streaming)
src/app/api/              health / keys / tasks للواجهة
src/app/page.tsx          لوحة الإدارة العربية RTL
merger/                   خدمة دمج الفيديو الكاملة (قسم مستقل)
```
