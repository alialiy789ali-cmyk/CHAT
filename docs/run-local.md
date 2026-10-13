# التشغيل المحلي · Run locally

## المتطلبات

- **Node.js 22+** (نستخدم `import.meta.dirname` وميزات حديثة).
- لا حاجة إلى Docker أو PostgreSQL مثبّت في التطوير: الخادم يشغّل **PostgreSQL 16 مدمجاً**
  (`embedded-postgres`) على المنفذ 54329 داخل `apps/server/var/pgdata`.
- منافذ مستخدمة: `8787` (الخادم)، `3000` (الويب)، `54329` (قاعدة البيانات المدمجة).

## التشغيل بأمر واحد

```bash
git clone <repo> && cd CHAT
npm install
npm run dev
```

`npm run dev` يشغّل الخادم والویب معاً (`concurrently`). أول تشغيل:
يشغّل PostgreSQL المدمج، ينفّذ الترحيلات، يُنشئ أسرار التطوير في `apps/server/var/secrets/`.

| الرابط | الوصف |
| --- | --- |
| <http://localhost:3000> | واجهة الويب |
| <http://localhost:8787/api/health> | فحص صحة الخادم وقاعدة البيانات |

## بيانات تجريبية

```bash
npm run seed
```

يُنشئ: `layla` و`omar` و`hala` (كلمة المرور `Sovereign-Demo-2026`)، محادثة فردية بتاريخ،
مجموعة «فريق المنتج»، قناة `sovereign_news` بمنشورين، منشورات عامة مع تعليق وإعجاب، وبلاغ مفتوح
لمشرف. الأمر **idempotent** — إعادة تشغيله لا تُكرِّر البيانات.

سيناريو تجربة:

1. افتح <http://localhost:3000> في نافذة عادية وسجّل الدخول بـ`layla`.
2. افتح نافذة خاصة (Private) وسجّل الدخول بـ`omar`.
3. أرسل رسالة من إحداهما — تظهر فوراً في الأخرى (WebSocket).
4. من رأس المحادثة: `📞` مكالمة صوتية أو `🎥` مرئية — اسمح بالميكروفون/الكاميرا.
5. من «الموجز» انشر منشوراً، ومن الحساب الآخر أعجب/علّق/تابع.
6. من «القنوات» افتح `sovereign_news` أو أنشئ قناة ثم أنشئ رابط دعوة.

## الأوامر

```bash
npm run dev              # الخادم + الويب
npm run dev:server       # الخادم فقط
npm run dev:web          # الويب فقط
npm run db:status        # هل قاعدة البيانات المدمجة تعمل؟
npm run db:down          # إيقافها
npm run db:reset         # حذفها وإعادة إنشائها (يرفض العمل مع DATABASE_URL خارجي)
npm run seed             # بيانات تجريبية
npm run smoke            # فحص شامل ضد خادم يعمل
npm run check:api        # عقود الواجهة (يتطلب تشغيل الويب والخادم)
npm run test             # اختبارات الوحدة
npm run test:e2e         # اختبارات القبول (تبدأ قاعدة بيانات على المنفذ 54331)
npm run typecheck        # فحص الأنواع
npm run build            # بناء الإنتاج للخادم والویب
```

## استخدام PostgreSQL خارجي في التطوير

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/sovereign
npm run dev:db           # ترحيل فقط (لا يشغّل المدمج)
npm run dev
```

## استكشاف الأخطاء

| العرض | السبب والحل |
| --- | --- |
| `EADDRINUSE :8787` | نسخة سابقة تعمل: `pkill -f "tsx src/index.ts"` |
| `port 54329 already in use` | `npm run db:down` ثم `npm run dev` |
| الويب يفتح لكن الطلبات تفشل | الخادم غير مشغّل: تأكد من `curl localhost:8787/api/health` |
| `Connection terminated unexpectedly` | بقايا خادم مدمج قديم: `npm run db:reset` |
| المكالمات تُعلّق على «يرن…» | الشبكة تحجب UDP: أضف TURN (`RTC_TURN_*`) — بدون TURN قد تعمل P2P على شبكة محلية فقط |
| البريد لا يصل | في التطوير `MAIL_DRIVER=console` يطبع الرسائل في سجل الخادم، ويُعيد رمز التحقق في الاستجابة |

## متغيرات البيئة المهمة

كل المتغيرات في [`.env.example`](../.env.example) مع شرحها. أهمها للتطوير:

| المتغير | الافتراضي | الأثر |
| --- | --- | --- |
| `DATABASE_URL` | (فارغ) | فارغ ⇒ PostgreSQL مدمج |
| `E2EE_ENABLED` | `false` | يرفض الخادم الرسائل المشفّرة؛ لا تدّعِ تشفيراً طرفياً قبل تفعيله واختباره |
| `RTC_TURN_URLS` / `RTC_TURN_SECRET` | (فارغ) | بدونهما لا يوجد مرحّل TURN |
| `UPLOAD_MAX_BYTES` | 52428800 | حد الرفع (50MB) |
| `REGISTRATION_INVITE_ONLY` | `false` | لتفعيل تسجيل مغلق برمز دعوة |
