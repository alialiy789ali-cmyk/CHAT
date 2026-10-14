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
    ar: 'المحادثات المشفّرة تُنشئ مفاتيح على جهازك أنت فقط؛ الخادم يمرّر نصوصاً مشفّرة لا يستطيع قراءتها. المفاتيح الخاصة لا تغادر المتصفح.',
    en: 'Encrypted conversations keep their keys on your device only; the server relays ciphertext it cannot read. Private keys never leave the browser.',
  },
  /* ------------------------------------------------------------------ E2EE */
  encryption: { ar: 'التشفير', en: 'Encryption' },
  encrypted: { ar: 'مشفّرة طرفياً', en: 'End-to-end encrypted' },
  notEncrypted: { ar: 'غير مشفّرة', en: 'Not encrypted' },
  enableEncryption: { ar: 'تفعيل التشفير', en: 'Enable encryption' },
  disableEncryption: { ar: 'إيقاف التشفير', en: 'Turn encryption off' },
  encryptionReady: { ar: 'كل الأجهزة جاهزة للتشفير', en: 'Every device is ready for encryption' },
  encryptionNotReady: {
    ar: 'لا يمكن تفعيل التشفير: بعض المشاركين لم ينشئوا مفاتيح بعد.',
    en: 'Encryption cannot be enabled: some participants have not created keys yet.',
  },
  verifyingDevice: { ar: 'التحقق من الأجهزة', en: 'Verify devices' },
  deviceKeys: { ar: 'أجهزة هذا المستخدم', en: "This user's devices" },
  myDevices: { ar: 'أجهزتي', en: 'My devices' },
  deviceFingerprint: { ar: 'بصمة الجهاز', en: 'Device fingerprint' },
  safetyNumber: { ar: 'رقم الأمان', en: 'Safety number' },
  safetyNumberHelp: {
    ar: 'قارن هذا الرقم مع الطرف الآخر عبر قناة أخرى (مكالمة أو لقاء مباشر). تطابق الأرقام يعني أنه لا يوجد طرف ثالث بينكما.',
    en: 'Compare these digits with your contact over another channel (a call, or in person). Matching numbers mean nobody is in the middle.',
  },
  markVerified: { ar: 'تأكيد التحقق', en: 'Mark as verified' },
  markUnverified: { ar: 'إلغاء التحقق', en: 'Remove verification' },
  verified: { ar: 'مُوثَّق', en: 'Verified' },
  unverified: { ar: 'غير مُوثَّق', en: 'Not verified' },
  keyChanged: {
    ar: 'تغيّر مفتاح هذا الجهاز. تحقّق من الرقم قبل الثقة به.',
    en: "This device's key changed. Verify the number before trusting it.",
  },
  deviceKeysPublished: { ar: 'مفاتيح الجهاز منشورة', en: 'Device keys published' },
  oneTimeKeysLeft: { ar: 'مفاتيح لمرّة واحدة متبقية', en: 'one-time keys left' },
  lockedMessage: {
    ar: '🔒 رسالة مشفّرة — هذا الجهاز لا يملك مفتاحها.',
    en: '🔒 Encrypted message — this device does not hold its key.',
  },
  decrypting: { ar: 'جارٍ فك التشفير…', en: 'Decrypting…' },
  decryptFailed: {
    ar: '⚠️ تعذّر فك التشفير (قد يكون الجهاز أُعيد تعيينه).',
    en: '⚠️ Decryption failed (the device may have been reset).',
  },
  e2eeUnsupported: {
    ar: 'متصفحك لا يدعم التخزين المشفّر المطلوب، لذا تعطّل التشفير طرفياً على هذا الجهاز.',
    en: 'This browser lacks the required secure-storage APIs, so end-to-end encryption is off on this device.',
  },
  e2eeBlocked: {
    ar: 'تعذّر إرسال رسالة مشفّرة: أحد المشاركين بلا جهاز مهيّأ.',
    en: 'Could not send an encrypted message: a participant has no ready device.',
  },
  securityCenter: { ar: 'مركز الأمان', en: 'Security centre' },
  someDevicesUnreachable: {
    ar: 'أُرسلت الرسالة، لكن بعض أجهزة المشاركين لن تقرأها: جهاز قديم نفدت مفاتيحه، أو جهاز يستخدم مخطط تشفير آخر (تطبيق الجوال مقابل المتصفح).',
    en: 'Message sent, but some participant devices will not read it: an old device with an exhausted key pool, or a device using the other encryption scheme (mobile app vs. browser).',
  },
  attachmentsNotEncrypted: {
    ar: 'المرفقات غير مشفّرة طرفياً بعد، لذلك تُعطَّل في المحادثات المشفّرة.',
    en: 'Attachments are not end-to-end encrypted yet, so they are disabled in encrypted chats.',
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
