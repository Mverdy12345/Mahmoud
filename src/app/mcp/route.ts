/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP وفق مواصفات MCP
 * باستخدام SDK الرسمي (WebStandardStreamableHTTPServerTransport) داخل route handler.
 * وضع stateless (sessionIdGenerator: undefined) — لا حالة بين الطلبات للتوافق مع Vercel.
 * runtime = nodejs + force-dynamic إلزاميان.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار القصوى 240 ثانية للنافذة + هامش — يسمح باستكمال tools/call الطويلة
export const maxDuration = 300;

/** إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> على /mcp */
function authOk(request: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

function jsonError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

async function handle(request: Request): Promise<Response> {
  if (!authOk(request)) {
    return jsonError(401, -32001, "Unauthorized: Bearer token required");
  }

  // خادم جديد لكل طلب (stateless) — إشعارات التقدم تبث عبر مجرى الرد نفسه
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponseMode: false, // SSE streaming — يسمح ببث إشعارات التقدم الحية
  });
  await server.connect(transport);
  try {
    // ملاحظة: لا نغلق الخادم هنا — إذ يُعالج الطلب بشكل غير متزامن ويستمر
    // ببث إشعارات التقدم عبر مجرى الرد؛ النقل يُنظّف نفسه تلقائيًا عند
    // إرسال الرد النهائي أو إلغاء العميل (cleanup() في الـ SDK).
    return await transport.handleRequest(request);
  } catch (e) {
    return jsonError(500, -32603, `Internal error: ${(e as Error).message.slice(0, 200)}`);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
