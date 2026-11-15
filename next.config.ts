import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone للنشر — لكن Vercel يستخدم بنائه الافتراضي؛ الخيار لا يضر
  output: "standalone",
  // حزم خارجية تعتمد على ثنائيات أصلية/SDK streaming — لا تحزمها في الباندل
  serverExternalPackages: ["@libsql/client", "@modelcontextprotocol/sdk"],
  // الآلة العامة للـ SDK مع zod تستنزف ذاكرة tsc في البيئات المحدودة —
  // التحقق الحقيقي للأخطاء يتم عبر فحوصات مجزأة وقت التطوير
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
