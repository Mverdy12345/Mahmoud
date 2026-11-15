/**
 * واجهة المزوّدات الموحدة — أي خطأ يُرمى كـ ProviderError ليُصنَّف في طبقة المفاتيح
 */
import type { KeyRow } from "../turso";

export interface ProviderInput {
  /** الحقول الأصلية للطلب (prompt, aspect_ratio, ...) كما وصلت من الأداة */
  payload: Record<string, unknown>;
  /** حقل اختياري غير موحّد يمرر لبعض المزودين */
  callBackUrl?: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(key: KeyRow, model: string, input: ProviderInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: KeyRow, input: ProviderInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: KeyRow, providerTaskId: string): Promise<CheckResult>;
}
