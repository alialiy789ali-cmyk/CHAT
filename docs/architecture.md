# العمارة · Architecture

## المبادئ

1. **السيادة**: كل مكوّن قابل للتشغيل على بنية المالك (PostgreSQL، Redis، MinIO/S3 متوافق، coturn).
   لا اعتماد إلزامي على خدمة سحابية. External deps الوحيدة الاختيارية: SMTP، LiveKit، APNs/FCM — وكلها مُعلنة.
2. **لا ادعاءات**: أي ميزة غير مكتملة تُعاد بـ`503` أو تُرفض صراحةً، وتُوثّق في `docs/feature-log.md`.
3. **حدود واضحة**: `routes → services → domain (repositories)`؛ لا SQL في المتحكمات ولا منطق أعمال في المستودعات.
4. **الاختبار يسبق الادعاء**: كل ميزة يقابلها اختبار وحدة أو قبول شامل يعمل ضد PostgreSQL حقيقي.

## المكوّنات

```
apps/server/
  src/config/        التحقق من البيئة (zod) + الأسرار + وصف مُخفّى للإعدادات
  src/db/            pool.ts (Db interface) · migrate.ts · migrations/0001..0004 · embedded.ts
  src/domain/        مستودعات: users, sessions, auth tokens, conversations, messages,
                     attachments/files, posts, channels, moderation, notifications, calls, keys
  src/services/      منطق الأعمال: auth, users, messaging, uploads, channels, social,
                     moderation, calls, events (ناقل أحداث), container (حقن التبعيات)
  src/routes/        نقاط النهاية (Fastify) — auth, users, messaging, files, social,
                     channels, calls, moderation, health
  src/realtime/      gateway.ts (ترحيل الإطارات) · hub.ts (توزيع المشتركين)
  src/plugins/       auth (المصادقة)، error-handler، security (helmet/cors/rate-limit)
  src/lib/           errors, logger, password (argon2/scrypt), crypto, cache, storage, sigv4, mail
apps/web/            Next.js 15 App Router + server.ts (بروكسي /api و /ws)
packages/shared/     types.ts · protocol.ts (إطارات الوقت الحقيقي) · validation.ts (zod مشترك)
```

## تدفّق الطلب

```
HTTP → Fastify → plugin(security) → plugin(auth: Bearer JWT) → route(schema parse)
     → service (تحقق الصلاحيات) → repository (SQL معامل) → serializer (DTO)
```

كل طلب يحمل `RequestContext`: `{ ip, userAgent, requestId, userId, sessionId, deviceId }` ويُستخدم
في سجل التدقيق وتحليلات إساءة الاستخدام.

## الوقت الحقيقي

- المصافحة: `POST /api/auth/realtime-ticket` (رمز 90 ثانية موقّع) ثم `GET /ws?ticket=...`.
- البوابة تتحقق من: صلاحية التذكرة، الجلسة غير ملغاة، حالة الحساب، وحد الاتصالات لكل مستخدم.
- إطاراته: `hello/ready/ping/pong`, `subscribe/unsubscribe`, `message.*`, `receipt`, `typing`,
  `presence`, `call.signal`, `notification`, `ack`, `error`.
- حدود: 600 إطار/دقيقة/اتصال، 200 محادثة مشترك بها، 5 اتصالات لكل مستخدم، حد المشترك البطيء.
- `hub.ts` يوزّع الأحداث عبر المشتركين محلياً، ومع `CACHE_DRIVER=redis` تُنشر الأحداث بين نسخ
  الخادم المتعددة (توسّع أفقي)، مع وسوم `originInstance` لمنع الازدواج.

## قاعدة البيانات

- PostgreSQL 16، `pgcrypto` + `citext`، معرّفات UUID افتراضية.
- الترحيلات 0001..0004: المستخدمون/الجلسات/الرموز/الأجهزة → المحادثات/الرسائل/الإيصالات/المرفقات
  → المنشورات/القنوات/البلاغات/الإشعارات → المفاتيح/الاشتراكات/المكالمات/الغرف.
- قيود سلامة حقيقية: مفاتيح خارجية، `unique` على (conversation_id, client_message_id) لمنع
  التكرار، حالات مُقيّدة بـCHECK، وفهارس على مسارات الاستعلام الساخنة.
- لا معاملات عبر التجمّع (`pool.query('BEGIN')` غير مسموح) — المعاملات تستخدم اتصالاً مخصّصاً.

## التوسّع والحدود

| البُعد | الوضع الحالي | التوسّع |
| --- | --- | --- |
| الخادم | نسخة واحدة | نسخ متعددة + Redis + موازن أحمال (sticky غير مطلوب للنطاقات، مطلوب للـWS) |
| الوسائط | P2P | TURN ذاتي، ثم SFU (LiveKit) للمكالمات الجماعية |
| الملفات | قرص محلي | S3/MinIO (منفّذ) |
| البريد | سجل/ملف | SMTP |
| الجلسات | PostgreSQL | فهارس جاهزة؛ التوسّع بـread replicas لاحقاً |

## الويب

- App Router مع تقسيم المسارات: عامة (`/`, `/login`, `/register`, `/reset-password`) ومحمية (`/app/*`).
- الرمز في الذاكرة فقط، والتحديث عبر كوكي httpOnly + إعادة محاولة واحدة عند 401.
- كل النصوص عربية افتراضية RTL مع تبديل فوري للإنجليزية LTR، وسمة داكنة/فاتحة/نظامية.
- تصميم أصلي: لوحة ألوان واحدة، حلقات تركيز واضحة، حالات تحميل/فراغ/خطأ في كل شاشة.

## Jوالجوال (المرحلة 4 — مخطّط)

React Native (TypeScript) يستخدم `packages/shared` نفسه للأنواع والتحقق، ويستهلك نفس الـAPI/WS.
لا كود مشارك مع الويب في طبقة العرض، بل في العقد فقط — لتجنّب قيود WebView.
