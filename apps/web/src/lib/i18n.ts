/**
 * Minimal, dependency-free localisation for Arabic (RTL, default) and English (LTR).
 * Strings live in one object so adding a language is a single new column.
 */

export type Locale = 'ar' | 'en';

type Dict = Record<string, { ar: string; en: string }>;

const strings: Dict = {
  appName: { ar: 'سيادي', en: 'Sovereign' },
  tagline: { ar: 'منصة تواصل تستضيفها بنفسك', en: 'The communication platform you host yourself' },
  heroSubtitle: {
    ar: 'مراسلة فورية مشفّرة النقل، قنوات بث، شبكة اجتماعية، ومكالمات صوتية ومرئية — كلها على بنيتك التحتية.',
    en: 'Instant messaging, broadcast channels, a social timeline and audio/video calls — all on your own infrastructure.',
  },
  signIn: { ar: 'تسجيل الدخول', en: 'Sign in' },
  signUp: { ar: 'إنشاء حساب', en: 'Create account' },
  username: { ar: 'اسم المستخدم', en: 'Username' },
  email: { ar: 'البريد الإلكتروني', en: 'Email' },
  password: { ar: 'كلمة المرور', en: 'Password' },
  displayName: { ar: 'الاسم الظاهر', en: 'Display name' },
  twoFactorCode: { ar: 'رمز التحقق بخطوتين', en: 'Two-factor code' },
  logout: { ar: 'تسجيل الخروج', en: 'Sign out' },
  chats: { ar: 'المحادثات', en: 'Chats' },
  timeline: { ar: 'الموجز', en: 'Timeline' },
  channels: { ar: 'القنوات', en: 'Channels' },
  notifications: { ar: 'الإشعارات', en: 'Notifications' },
  settings: { ar: 'الإعدادات', en: 'Settings' },
  profile: { ar: 'الملف الشخصي', en: 'Profile' },
  search: { ar: 'بحث', en: 'Search' },
  send: { ar: 'إرسال', en: 'Send' },
  messagePlaceholder: { ar: 'اكتب رسالة…', en: 'Write a message…' },
  newConversation: { ar: 'محادثة جديدة', en: 'New conversation' },
  newGroup: { ar: 'مجموعة جديدة', en: 'New group' },
  members: { ar: 'الأعضاء', en: 'Members' },
  typing: { ar: 'يكتب…', en: 'typing…' },
  online: { ar: 'متصل', en: 'Online' },
  offline: { ar: 'غير متصل', en: 'Offline' },
  connecting: { ar: 'جارٍ الاتصال…', en: 'Connecting…' },
  reconnecting: { ar: 'إعادة الاتصال…', en: 'Reconnecting…' },
  audioCall: { ar: 'مكالمة صوتية', en: 'Audio call' },
  videoCall: { ar: 'مكالمة مرئية', en: 'Video call' },
  hangUp: { ar: 'إنهاء', en: 'Hang up' },
  answer: { ar: 'قبول', en: 'Answer' },
  decline: { ar: 'رفض', en: 'Decline' },
  ringing: { ar: 'يرن…', en: 'Ringing…' },
  mute: { ar: 'كتم', en: 'Mute' },
  unmute: { ar: 'إلغاء الكتم', en: 'Unmute' },
  cameraOff: { ar: 'إيقاف الكاميرا', en: 'Camera off' },
  cameraOn: { ar: 'تشغيل الكاميرا', en: 'Camera on' },
  whatIsHappening: { ar: 'ماذا يحدث؟', en: 'What is happening?' },
  post: { ar: 'نشر', en: 'Post' },
  reply: { ar: 'رد', en: 'Reply' },
  like: { ar: 'إعجاب', en: 'Like' },
  repost: { ar: 'إعادة نشر', en: 'Repost' },
  comment: { ar: 'تعليق', en: 'Comment' },
  follow: { ar: 'متابعة', en: 'Follow' },
  unfollow: { ar: 'إلغاء المتابعة', en: 'Unfollow' },
  block: { ar: 'حظر', en: 'Block' },
  unblock: { ar: 'إلغاء الحظر', en: 'Unblock' },
  report: { ar: 'إبلاغ', en: 'Report' },
  delete: { ar: 'حذف', en: 'Delete' },
  edit: { ar: 'تعديل', en: 'Edit' },
  save: { ar: 'حفظ', en: 'Save' },
  cancel: { ar: 'إلغاء', en: 'Cancel' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
  empty: { ar: 'لا يوجد شيء بعد', en: 'Nothing here yet' },
  privacy: { ar: 'الخصوصية', en: 'Privacy' },
  security: { ar: 'الأمان', en: 'Security' },
  devices: { ar: 'الأجهزة والجلسات', en: 'Devices & sessions' },
  exportData: { ar: 'تصدير بياناتي', en: 'Export my data' },
  deleteAccount: { ar: 'حذف الحساب', en: 'Delete account' },
  appearance: { ar: 'المظهر', en: 'Appearance' },
  language: { ar: 'اللغة', en: 'Language' },
  theme: { ar: 'السمة', en: 'Theme' },
  light: { ar: 'فاتح', en: 'Light' },
  dark: { ar: 'داكن', en: 'Dark' },
  system: { ar: 'حسب النظام', en: 'System' },
  createChannel: { ar: 'إنشاء قناة', en: 'Create channel' },
  subscribe: { ar: 'انضمام', en: 'Subscribe' },
  unsubscribe: { ar: 'مغادرة', en: 'Unsubscribe' },
  newPostInChannel: { ar: 'منشور جديد في القناة', en: 'New channel post' },
  moderation: { ar: 'الإشراف', en: 'Moderation' },
  openReports: { ar: 'البلاغات المفتوحة', en: 'Open reports' },
  resolve: { ar: 'معالجة', en: 'Resolve' },
  uploadFile: { ar: 'إرفاق ملف', en: 'Attach file' },
  voiceMessage: { ar: 'رسالة صوتية', en: 'Voice message' },
  startRecording: { ar: 'تسجيل', en: 'Record' },
  stopRecording: { ar: 'إيقاف التسجيل', en: 'Stop' },
  searchEverything: { ar: 'ابحث عن مستخدمين أو منشورات أو قنوات', en: 'Search users, posts or channels' },
  trending: { ar: 'الأكثر تداولاً', en: 'Trending' },
  following: { ar: 'المتابَعون', en: 'Following' },
  forYou: { ar: 'لك', en: 'For you' },
  verifiedEmailHint: {
    ar: 'تحقق من بريدك الإلكتروني لتفعيل كل الميزات.',
    en: 'Verify your email to unlock every feature.',
  },
  e2eeNotice: {
    ar: 'التشفير طرفي قيد التنفيذ ولم يُفعّل بعد. الرسائل محمية أثناء النقل (TLS) ومخزّنة على خادمك.',
    en: 'End-to-end encryption is implemented and being verified; it is not enabled yet. Messages are protected in transit (TLS) and stored on your own server.',
  },
};

let currentLocale: Locale = 'ar';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: keyof typeof strings | string, locale: Locale = currentLocale): string {
  const entry = strings[key as keyof typeof strings];
  if (!entry) return String(key);
  return entry[locale] ?? entry.ar;
}

export function useT() {
  return (key: keyof typeof strings | string) => t(key);
}

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'ar', label: 'العربية' },
  { id: 'en', label: 'English' },
];
