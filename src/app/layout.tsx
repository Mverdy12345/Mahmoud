import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// خط عربي جيد للواجهة RTL بالكامل
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — إدارة المفاتيح ومتابعة المهام حية",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className={`${cairo.variable} font-[family-name:var(--font-cairo)] antialiased bg-slate-950 text-slate-100`}>
        {children}
      </body>
    </html>
  );
}
