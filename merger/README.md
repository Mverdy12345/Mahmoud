# دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel** — Node.js خالص (CommonJS) بدون خطوة بناء، مع تخزين كامل في **Turso** وتشفير عالي الجودة عبر **ffmpeg** داخل الدالة.

## المزايا

- واجهة عربية RTL بثيم داكن حديث (تدرجات سماوي/بنفسجي): روابط مباشرة أو رفع ملفات بالسحب والإفلات، إعادة ترتيب بالسحب أو أسهم، شريط تقدم حقيقي من الخادم، نتيجة مع مشغل وحجم/مدة/دقة وعدّاد تنازلي 24 ساعة، واستئناف العرض عبر `#job=<id>`.
- دمج بجودة عالية إلزامية: توحيد كل المصادر (scale + pad إلى أكبر دقة بحد 1920×1080، fps=30، yuv420p)، مصدر بلا صوت يُضاف له مسار صامت بدل الفشل، المخرج **MP4 (H.264 CRF 18 + AAC 192k/44100Hz + faststart)**.
- تخزين Blobs مقسّم في Turso بصفوف 2MB مع قراءة تدفقية، وبث الفيديو يدعم **Range (206)** ليعمل التقديم/الترجيع.
- حذف تلقائي بعد 24 ساعة: تنظيف كسول عند كل إنشاء/دمج + نقطة cron يومية.

## النشر على Vercel خطوة بخطوة

1. **أنشئ قاعدة Turso مجانية** (إن لم تكن لديك):
   ```bash
   turso db create <اسم-القاعدة>
   turso db show <اسم-القاعدة> --url      # انسخ الرابط
   turso db tokens create <اسم-القاعدة>   # انسخ التوكن
   ```
2. **ارفع المستودع إلى GitHub** ثم من Vercel: **Add New Project → Import**.
3. **Root Directory**: ضع `merger` (إن كان المشروع في مجلد فرعي داخل نفس المستودع).
4. **Environment Variables** → أضف:
   | المتغير | القيمة | إلزامي |
   |---|---|---|
   | `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` | نعم |
   | `TURSO_AUTH_TOKEN` | التوكن بصلاحيات كتابة | نعم |
   | `MAX_SOURCES` | `10` | لا |
   | `SOURCE_MAX_MB` | `200` | لا |
   | `OUTPUT_MAX_MB` | `150` | لا |
   | `MAX_TOTAL_DURATION_SEC` | `600` | لا |
   | `FFMPEG_PRESET` | `medium` | لا |
5. **Deploy** — كل شيء يعمل لأن libSQL يتصل عبر HTTP، ولا يوجد أي ملف محلي.

## توثيق API (بدون تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الناتج |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي) |

### أمثلة curl بعد النشر (استبدل `<BASE>` بدومينك)

```bash
# 1) إنشاء مهمة من روابط
curl -X POST <BASE>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://site.com/clip1.mp4","https://site.com/clip2.mp4"]}'
# → 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 2) تنفيذ الدمج (متزامن، يستغرق ~10–15 ثانية للمقاطع القصيرة)
curl -X POST <BASE>/api/jobs/<jobId>/process
# → 200 {"status":"done","videoUrl":"<BASE>/api/jobs/<id>/video","downloadUrl":"...",
#        "size":1234567,"duration":30.2,"resolution":"640x360","expiresAt":"..."}

# 3) الحالة والتقدم
curl <BASE>/api/jobs/<jobId>
# → {"jobId":"...","status":"done","progress":100,"videoUrl":"...","downloadUrl":"..."}

# 4) تنزيل الناتج / البث
curl -OJ <BASE>/api/jobs/<jobId>/video?download=1

# 5) مهمة بملفات مرفوعة (مصادر مختلطة)
curl -X POST <BASE>/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://site.com/a.mp4"},{"kind":"file","name":"b.mp4","size":10240000,"mime":"video/mp4"}]}'
# يرجع 201 مع uploads[] برابط رفع لكل مصدر + uploadChunkBytes (4MB)
# ثم ارفع كل جزء بالترتيب:
curl -X POST "<BASE>/api/upload?job=<id>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @chunk0.bin

# 6) الحذف الفوري الشامل
curl -X DELETE <BASE>/api/jobs/<jobId>
```

**حالات المهمة:** `queued` → (`uploading`) → `processing` → `done` | `failed`.

**الأكواد:** 400 مدخلات تالفة، 404 غير موجود، 409 حالة غير مناسبة، 413 تجاوز الحجم، 405 طريقة خاطئة.

## الحدود

| الحد | القيمة |
|---|---|
| عدد المقاطع | 10 كحد أقصى |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع مدد المقاطع | 600 ثانية |
| حجم جزء الرفع | 4MB (حد Vercel ≈ 4.5MB) |
| مدة الاحتفاظ | 24 ساعة ثم حذف تلقائي |

## حدود الخطة المجانية التي يجب معرفتها

- **مدة الدالة:** `vercel.json` يطلب `maxDuration: 300`. على خطة Hobby مع Fluid compute يُسمح حتى 300 ثانية؛ إن رفض النشر فخفّض القيمة إلى `60` (الدمج القصير يكتمل عادةً في 10–15 ثانية).
- **حجم الطلب:** ≈ 4.5MB — لذلك الرفع دائمًا أجزاء 4MB مع إعادة محاولة ×3 (الواجهة تفعل ذلك تلقائيًا).
- **قاعدة Turso المجانية:** ~5GB تخزين — الناتج يُحذف بعد 24 ساعة والناتج فقط هو المخزَّن (أجزاء المصادر تُحذف فور نجاح الدمج).
- لا نظام ملفات دائم: `/tmp` فقط أثناء المعالجة ويُنظَّف في `finally`.

## التطوير والاختبار محليًا

```bash
cp .env.example .env        # املأ متغيري Turso
npm install
npm run dev                 # خادم تطوير يحاكي Vercel على المنفذ 3001
npm run test:unit           # اختبار الوحدات (توليد مصدرين والتحقق من الدمج والتخزين)
npm run test:http           # اختبار HTTP كامل ضد خادم التطوير
```

## البنية

```
api/        الدوال (jobs, upload, process, video, config, cron)
lib/        المنطق (db, store, merge, pipeline, utils, env)
public/     الواجهة (index.html)
scripts/    اختبارات الوحدات و HTTP
```
