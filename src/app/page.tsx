"use client";

/**
 * لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
 *  أ) مدير المفاتيح  ب) لوحة المهام (تحديث تلقائي كل ~5 ثوانٍ)  ج) ربط السيرفر
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Copy, KeyRound, ListVideo, Plug, RefreshCw, Trash2, ToggleLeft, ToggleRight, Activity } from "lucide-react";

/* ------------------------------- الأنواع ------------------------------- */

interface MaskedKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  authRequired: boolean;
  merger: { base: string | null; healthy: boolean };
}

/* ------------------------------- الصفحة ------------------------------- */

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<MaskedKey[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  // الأصل يُحسم بعد التحميل فقط — يمنع اختلاف hydration بين الخادم والعميل
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      if (j.ok) setKeys(j.keys);
    } catch {
      /* تجاهل أخطاء الاستطلاع */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      if (j.ok) {
        setTasks(j.tasks);
        setStats(j.stats);
      }
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t = setInterval(() => {
      loadTasks();
      loadHealth();
      loadKeys();
    }, 5000);
    return () => clearInterval(t);
  }, [loadTasks, loadHealth, loadKeys]);

  async function addKey() {
    if (!apiKey.trim()) {
      toast({ title: "أدخل مفتاح الـ API أولًا" });
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (j.ok) {
        toast({ title: "أُضيف المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        loadKeys();
      } else {
        toast({ title: "فشل الإضافة", description: j.error, variant: "destructive" });
      }
    } finally {
      setAdding(false);
    }
  }

  async function toggleKey(k: MaskedKey) {
    const action = k.status === "disabled" ? "enable" : "disable";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    loadKeys();
  }

  async function deleteKey(k: MaskedKey) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "حُذف المفتاح" });
    loadKeys();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "نُسخ إلى الحافظة" });
    } catch {
      toast({ title: "تعذر النسخ — انسخ يدويًا" });
    }
  }

  const mcpUrl = `${origin}/mcp`;

  /* JSON جاهز للنسخ لكل عميل */
  const jsons = useMemo(() => {
    const auth = health?.authRequired
      ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
      : "";
    return {
      chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
    };
  }, [mcpUrl, health]);

  const statusBadge = (s: MaskedKey["status"]) =>
    s === "active" ? (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">نشط</Badge>
    ) : s === "exhausted" ? (
      <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">مستنزف</Badge>
    ) : (
      <Badge className="bg-slate-500/15 text-slate-400 border-slate-500/30">معطّل</Badge>
    );

  const taskStatusBadge = (s: TaskItem["status"]) =>
    s === "completed" ? (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">مكتملة</Badge>
    ) : s === "failed" ? (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30">فاشلة</Badge>
    ) : s === "processing" ? (
      <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30">جارية</Badge>
    ) : (
      <Badge className="bg-slate-500/15 text-slate-400 border-slate-500/30">بانتظار</Badge>
    );

  const typeLabel = (t: TaskItem["type"]) =>
    t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج";

  // صيغة ثابتة تتجنب اختلاف hydration بين الخادم والعميل (بلا تنسيق locale)
  const fixedTime = (s: string) => (s || "").slice(0, 16).replace("T", " ");

  const tools = [
    { name: "generate_image", desc: "توليد صورة بـ gpt-image-2-6/flare-text-to-image مع تبديل تلقائي للمفاتيح" },
    { name: "generate_video", desc: "توليد فيديو بـ grok-imagine-video-1-5-preview بصوت متزامن أصلي" },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (حتى 10 مقاطع)" },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج" },
    { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد" },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* الهيدر — حالة /api/health */}
        <header className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">MCP Media Generator</h1>
            <p className="text-sm text-slate-400">خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة إدارة عربية</p>
          </div>
          <div className="flex items-center gap-2">
            {health?.database === "turso-connected" ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1">
                <Activity className="h-3.5 w-3.5" /> Turso متصل
              </Badge>
            ) : (
              <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1">
                <Activity className="h-3.5 w-3.5" /> غير متصل
              </Badge>
            )}
            {health?.merger.base ? (
              health.merger.healthy ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">خدمة الدمج جاهزة</Badge>
              ) : (
                <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">خدمة الدمج غير مستجيبة</Badge>
              )
            ) : (
              <Badge className="bg-slate-500/15 text-slate-400 border-slate-500/30">خدمة الدمج غير مهيأة</Badge>
            )}
          </div>
        </header>

        {/* أ) مدير المفاتيح */}
        <Card className="bg-slate-900/60 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="h-5 w-5 text-sky-400" /> مدير المفاتيح
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-300 bg-slate-800/60 rounded-lg p-3 border border-slate-700/60">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </p>
            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="provider">المزود</Label>
                <select
                  id="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full h-10 rounded-md bg-slate-800 border border-slate-700 px-3 text-sm"
                >
                  <option value="kie">kie.ai</option>
                  <option value="cometapi">CometAPI</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="label">تسمية (اختياري)</Label>
                <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مثل: حساب رئيسي" className="bg-slate-800 border-slate-700" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="apikey">مفتاح الـ API</Label>
                <div className="flex gap-2">
                  <Input id="apikey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="الصق المفتاح هنا" className="bg-slate-800 border-slate-700" dir="ltr" />
                  <Button onClick={addKey} disabled={adding}>إضافة</Button>
                </div>
              </div>
            </div>

            <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {keys.length === 0 && (
                <p className="text-sm text-slate-400 p-4">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لتشغيل التوليد.</p>
              )}
              {keys.map((k) => (
                <div key={k.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 p-3">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="font-mono text-xs text-slate-300" dir="ltr">{k.masked}</span>
                    {statusBadge(k.status)}
                    {k.label && <span className="text-xs text-slate-400">{k.label}</span>}
                  </div>
                  <div className="text-xs text-slate-400 sm:text-center" dir="ltr">
                    استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}
                  </div>
                  {k.last_error && (
                    <div className="text-xs text-red-400/90 truncate max-w-60" dir="ltr" title={k.last_error}>
                      {k.last_error.slice(0, 60)}
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => toggleKey(k)} title={k.status === "disabled" ? "تنشيط" : "تعطيل"}>
                      {k.status === "disabled" ? <ToggleRight className="h-4 w-4 text-emerald-400" /> : <ToggleLeft className="h-4 w-4 text-amber-400" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteKey(k)} title="حذف">
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ب) لوحة المهام */}
        <Card className="bg-slate-900/60 border-slate-800">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ListVideo className="h-5 w-5 text-violet-400" /> لوحة المهام
            </CardTitle>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <RefreshCw className="h-3.5 w-3.5 animate-[spin_5s_linear_infinite]" /> تحديث تلقائي كل 5 ثوانٍ
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* شرائح الإحصائيات */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg bg-slate-800/60 border border-slate-700/60 p-3">
                <p className="text-xs text-slate-400">الإجمالي</p>
                <p className="text-xl font-bold">{stats.total}</p>
              </div>
              <div className="rounded-lg bg-emerald-950/40 border border-emerald-800/40 p-3">
                <p className="text-xs text-emerald-300/80">مكتملة</p>
                <p className="text-xl font-bold text-emerald-400">{stats.completed}</p>
              </div>
              <div className="rounded-lg bg-red-950/40 border border-red-800/40 p-3">
                <p className="text-xs text-red-300/80">فاشلة</p>
                <p className="text-xl font-bold text-red-400">{stats.failed}</p>
              </div>
              <div className="rounded-lg bg-sky-950/40 border border-sky-800/40 p-3">
                <p className="text-xs text-sky-300/80">جارية</p>
                <p className="text-xl font-bold text-sky-400">{stats.processing}</p>
              </div>
            </div>

            <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 max-h-96 overflow-y-auto">
              {tasks.length === 0 && (
                <p className="text-sm text-slate-400 p-4">لا توجد مهام بعد — استدعِ أدوات التوليد من عميل MCP.</p>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{typeLabel(t.type)}</span>
                    {taskStatusBadge(t.status)}
                    <span className="text-xs text-slate-500 font-mono" dir="ltr">{t.model}</span>
                    <span className="text-xs text-slate-500">{fixedTime(t.created_at)}</span>
                    {t.attempts_count > 0 && (
                      <span className="text-xs text-slate-400">محاولات: {t.attempts_count}</span>
                    )}
                  </div>
                  {t.prompt && <p className="text-xs text-slate-400 truncate">{t.prompt}</p>}
                  {(t.status === "processing" || t.status === "pending") && (
                    <Progress value={t.progress} className="h-1.5" />
                  )}
                  {t.error_message && t.status === "failed" && (
                    <p className="text-xs text-red-400/90">{t.error_message}</p>
                  )}
                  {t.urls.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {t.urls.map((u, i) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer" className="text-xs text-sky-400 underline truncate max-w-80" dir="ltr">
                          {u.length > 60 ? u.slice(0, 60) + "…" : u}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ج) ربط السيرفر */}
        <Card className="bg-slate-900/60 border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Plug className="h-5 w-5 text-amber-400" /> ربط السيرفر
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input readOnly value={mcpUrl} dir="ltr" className="bg-slate-800 border-slate-700 font-mono text-xs" />
              <Button variant="secondary" onClick={() => copy(mcpUrl)}>
                <Copy className="h-4 w-4" /> نسخ
              </Button>
            </div>

            <Tabs defaultValue="chatgpt">
              <TabsList className="bg-slate-800">
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs font-mono overflow-x-auto" dir="ltr">{jsons.chatgpt}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(jsons.chatgpt)}><Copy className="h-3.5 w-3.5" /> نسخ JSON</Button>
                <p className="text-xs text-slate-400">في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».</p>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs font-mono overflow-x-auto" dir="ltr">{jsons.claude}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(jsons.claude)}><Copy className="h-3.5 w-3.5" /> نسخ JSON</Button>
                <p className="text-xs text-slate-400">ضعه في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.</p>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <pre className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs font-mono overflow-x-auto" dir="ltr">{jsons.cursor}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(jsons.cursor)}><Copy className="h-3.5 w-3.5" /> نسخ JSON</Button>
                <p className="text-xs text-slate-400">ضعه في mcp.json الخاص بالمحرر (Cursor / Windsurf / Cline).</p>
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2">
              {tools.map((t) => (
                <div key={t.name} className="rounded-lg border border-slate-700/70 bg-slate-800/50 p-2.5 max-w-xs">
                  <p className="text-xs font-mono text-sky-400" dir="ltr">{t.name}</p>
                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{t.desc}</p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </div>
          </CardContent>
        </Card>

        <footer className="text-center text-xs text-slate-500 py-4">
          MCP Media Generator — روابط فقط دون تنزيل وسائط · تبديل تسلسلي للمفاتيح دون توقف · إخفاء المفاتيح دائمًا
        </footer>
      </div>
    </main>
  );
}
