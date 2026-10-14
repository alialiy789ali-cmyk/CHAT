# واجهة البرمجة · API reference

كل المسارات تحت `/api`. المصادقة عبر ترويسة `Authorization: Bearer <accessToken>`،
والتحديث عبر كوكي `sovereign_refresh` (httpOnly) أو حقل `refreshToken` في الجسم (للجوال).

**شكل الاستجابة:** نجاح = الكائن مباشرة. خطأ = `{ "error": { "code": "...", "message": "...", "details": ... } }`
مع رموز HTTP صحيحة (400/401/403/404/409/413/429/503). رموز الأخطاء موحّدة في `src/lib/errors.ts`.

**تحديد المعدل:** 429 يحمل `Retry-After` و`retryAfterSeconds` في الجسم.

---

### التشفير الطرفي (E2EE)

يوزّع الخادم **المفاتيح العامة** وينقل **النص المشفّر** كما هو. لا يستقبل الخادم مفتاحاً خاصاً
أبداً، ولا يستطيع فك المحتوى. مخططان مدعومان: `libsignal-v1` (تطبيق الجوال) و`olm-v1` (تطبيق الويب).

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| PUT | `/keys/identity` | نشر/تدوير مفاتيح جهاز Signal: `{identityKey, registrationId, signedPreKey{id,publicKey,signature}, kyberPreKey?, oneTimePreKeys[]}` (base64) → `{deviceId, identityRotated, oneTimePreKeysStored}` |
| POST | `/keys/prekeys` | تعبئة prekeys لمرة واحدة `{oneTimePreKeys[]}` عندما ينخفض العدد |
| PUT | `/keys/identity/olm` | نشر/تدوير جهاز Olm (الويب): `{deviceId?, identityKey, signingKey, signature, oneTimeKeys[{id,key}]}` → `{deviceId, algorithm: 'olm-v1', identityRotated, oneTimeKeysStored}` |
| POST | `/keys/prekeys/olm` | تعبئة مفاتيح Olm لمرة واحدة `{deviceId?, oneTimeKeys[]}` → `{oneTimeKeysStored}` |
| GET | `/keys/me` | جرد لكل جهاز: `{deviceId, algorithm, signingKey, remainingOneTimePreKeys, identityKey, verifiedAt}` |
| GET | `/keys/:userId/devices` | **دليل الأجهزة**: `{targetUserId, devices:[{deviceId, algorithm, identityKey, signingKey, identitySignature}]}` — بلا أي مفاتيح لمرّة واحدة (لا يستهلك شيئاً)، فمن الآمن استدعاؤه قبل كل إرسال لمعرفة من وُجد حديثاً |
| GET | `/keys/:userId` | حزم المفاتيح للمصافحة: تستهلك مفتاحاً واحداً لكل جهاز من أجهزة الطرف (`oneTimePreKey`) |
| GET | `/keys/:userId` | حِزم الأجهزة للطرف الآخر — **يُستهلك مفتاح لمرة واحدة لكل جهاز** عند كل طلب، ويحترم الخصوصية والحظر. حزمة Olm تحمل `signingKey` + `identitySignature` ليتمكن العميل من التحقق الذاتي |
| POST | `/keys/verify` | `{deviceId, fingerprint, verified}` — تحقق **لك أنت وحدك** من بصمة جهاز الطرف الآخر |
| GET | `/keys/verify/:userId` | حالة التحقق لكل أجهزة المستخدم كما تراها أنت، مع `identityKey`/`signingKey` العامّين لحساب رقم الأمان محلياً |
| GET | `/conversations/:id/encryption` | حالة التشفير + جاهزية كل مشارك (`participants[].ready`, `participants[].algorithms`) |
| POST | `/conversations/:id/encryption` | `{enabled}` — للتفعيل يشترط أن يكون **كل** مشارك قد نشر مفاتيح، وإلا 409 `participant_without_keys:<id>` |
| GET | `/messages/:messageId/envelope` | **مغلّف هذا الجهاز فقط** لرسالة (`{envelope}` أو `null`) — العضو فقط، والإطارات اللحظية لا تحمل نصاً مشفّراً |

ملاحظات تشغيلية مهمة:

- كل ما سبق معطّل ما لم يكن `E2EE_ENABLED=true` (وهو الافتراضي)، وعند التعطيل يرد الخادم 501
  `e2ee_not_available` بدل القبول الصوري.
- الإرسال المشفّر يستخدم **مغلّفاً لكل جهاز**:
  `POST /conversations/:id/messages {clientMessageId, body: '', encryptionScheme: 'olm-v1', envelopes:[{deviceId, scheme, ciphertext}]}`
  ويُرفض بـ400 `envelope_for_unknown_device` أي مغلّف موجّه لجهاز خارج المحادثة. الرد يعيد
  `body: null` و`envelopes: []` (مغلّفات الآخرين ليست من حق المرسل).
- الشكل القديم بمغلّف واحد (`ciphertext` + `encryptionScheme`) ما زال مقبولاً للتوافق.
- الرسائل اللحظية (`t: 'message'`) تحمل البيانات الوصفية فقط وبلا `envelopes`؛ كل جهاز يجلب
  مغلّفه من `GET /messages/:id/envelope`.
- في المحادثة المشفّرة يرفض الخادم النص العادي (501) حتى لا يحدث «تخفيض صامت» للتشفير، كما يرفض
  تعديل رسالة مشفّرة (`cannot_edit_ciphertext_message`) وإعادة توجيهها
  (`cannot_forward_ciphertext_message`).
- قناة ومنشورات القنوات **ليست** مشفّرة طرفياً بطبيعتها (محتوى عام/واسع الانتشار) ويجب أن يظهر
  ذلك بصراحة في الواجهة.
- البحث في الرسائل لا يمكن أن يعثر على رسائل مشفّرة: لا يوجد `body` ليفهرسه الخادم.

## المصادقة

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| POST | `/auth/register` | `{username, email, password, displayName?, device?}` → `{user, accessToken, refreshToken, expiresIn, sessionId, deviceId}` (201) |
| POST | `/auth/login` | `{identifier, password, totp?, device?}` → نفس الشكل. `totp_required` عند تفعيل التحقق بخطوتين |
| POST | `/auth/password/change` | `{currentPassword, newPassword}` → `{changed, revokedSessions}` — ينهي جلسات **الأجهزة الأخرى** ويُبقي جلسة الجالس أمام الجهاز |
| POST | `/auth/password/request-reset` | `{email}` → `{sent: true}` دائماً (لا كشف للحسابات)؛ الرابط في البريد صالح 30 دقيقة |
| POST | `/auth/password/reset` | `{token, newPassword}` → `{reset: true}` — يُنهي **كل** الجلسات، وهو طريق الاستعادة عند امتلاء جدول الجلسات |
| POST | `/auth/refresh` | يقرأ الكوكي أو `{refreshToken}` → رموز جديدة (تدوير إلزامي) |
| POST | `/auth/logout` \| `/auth/logout-all` | إلغاء الجلسة الحالية / كل الجلسات |
| — | — | ملاحظة: عند بلوغ `MAX_ACTIVE_SESSIONS` (10 افتراضياً) يفشل الدخول بـ403 `too_many_sessions` بدل إسقاط جلسة قائمة |
| POST | `/auth/realtime-ticket` | → `{ticket, expiresIn}` — صلاحية 90 ثانية لفتح `/ws` |
| POST | `/auth/media-token` | → `{token, expiresIn: 300}` — رمز **قراءة فقط** لوسوم `<img>/<video>` (انظر «الملفات» أدناه) |
| GET | `/auth/sessions` | قائمة الجلسات مع `current: true/false` |
| DELETE | `/auth/sessions/:sessionId` | إلغاء جلسة محدّدة |
| POST | `/auth/verify-email` \| `/auth/resend-verification` | تأكيد البريد |
| POST | `/auth/password/request-reset` | `{email}` → رسالة؛ في وضع التطوير يعيد `devToken` |
| POST | `/auth/password/reset` | `{token, newPassword}` |
| POST | `/auth/password/change` | `{currentPassword, newPassword}` — يُلغي بقية الجلسات |
| POST | `/auth/2fa/setup` → `/auth/2fa/enable` → `/auth/2fa/verify` → `/auth/2fa/disable` | TOTP؛ `enable` يعيد 8 رموز استعادة مرة واحدة |

## المستخدمون والعلاقات

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| GET/PATCH | `/users/me` | الملف الخاص (يتضمن `email, locale, theme, privacy, stats`) / تحديث `{displayName, bio, locale, theme, avatarUrl}` |
| PATCH | `/users/me/privacy` | `{whoCanMessage, whoCanSeeProfile, readReceipts, showOnlineStatus}` |
| PATCH | `/users/me/notifications` | إعدادات الإشعارات |
| POST | `/users/me/avatar` | multipart (حقل `file`) |
| GET | `/users/me/export` | تصدير JSON كامل (يُبنى عند الطلب) |
| DELETE | `/users/me` | حذف الحساب (إخفاء هوية + إلغاء الجلسات) |
| GET/DELETE | `/users/me/devices[/:deviceId]` | الأجهزة. هوية الجهاز = **تثبيت** لا تسجيل دخول: يُرسل العميل `device.key` ثابتاً (مُولَّد محلياً في `localStorage`، ليس سرّاً ولا يصلح وحده للمصادقة) فيُعاد استخدام صفّ الجهاز نفسه عند الدخول مجدداً |
| GET | `/users/me/blocks` | قائمة الحظر |
| GET | `/users/:username` | `{user, stats, viewer, posts, online}` |
| POST/DELETE | `/users/:username/follow` \| `/users/:username/block` | متابعة/حظر بالاسم |
| GET | `/users/:username/followers` \| `/following` | قوائم |
| GET | `/users/suggestions` | مقترحات متابعة |
| GET | `/search?q=&type=all\|users\|posts\|channels&limit=` | بحث موحّد |

## المراسلة

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| GET | `/conversations` | `{items, nextCursor}` — ملخّصات مع آخر رسالة وعدّاد غير المقروء |
| POST | `/conversations/direct` | `{userId}` |
| POST | `/conversations/group` | `{title, memberIds[], description?, visibility?}` |
| GET/PATCH/DELETE | `/conversations/:id` | التفاصيل/التحديث/المغادرة |
| POST/DELETE | `/conversations/:id/members[/:userId]` | إدارة الأعضاء (حسب الدور) |
| POST | `/conversations/:id/members/role` | تغيير دور |
| GET | `/conversations/:id/messages?limit=&cursor=&q=` | `{items, nextCursor}` (الأحدث أولاً) |
| POST | `/conversations/:id/messages` | `{clientMessageId, body?, type?, replyToId?, attachmentIds?, mentions?}` → 201 جديد / 200 مكرر (`duplicated: true`) |
| GET/PATCH/DELETE | `/messages/:id` | قراءة/تعديل (48 ساعة)/حذف ناعم |
| POST | `/messages/:id/forward` | تمرير `{conversationIds[]}` |
| POST | `/conversations/:id/read` \| `/messages/delivered` | إيصالات القراءة/التسليم |
| POST | `/conversations/:id/typing` | مؤشر الكتابة (HTTP؛ الأفضل عبر WS) |
| GET | `/messages/search?q=` \| `/messages/unread-count` | بحث وإحصاء |

## الملفات

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| POST | `/files` | multipart (`file`, وحقل `durationMs` اختياري للرسائل الصوتية، وحقل `encrypted=true` للمرفقات المشفّرة طرفياً) → `{attachment}`. الخادم يفحص بايتات الملف ويقارنها بالنوع المُعلن: أي اختلاف ⇒ `415 content_type_mismatch`، ونوع غير مسموح ⇒ `415 mime_type_not_allowed`. مع `encrypted=true` يُخزَّن الاسم محايداً (`encrypted.bin`) والنوع `application/octet-stream` — الاسم والنوع الحقيقيان يبقيان داخل الحمولة المشفّرة |
| GET | `/files/:attachmentId` | ثلاثة أشكال للمصادقة (كلها تخضع لنفس فحص العضوية والجلسة): `Authorization: Bearer <access>`, أو `?token=<media token>`, أو `?access_token=<access>` على GET فقط. ترويسات `nosniff` و`CSP: sandbox` + `private, max-age=3600` |
| DELETE | `/files/:attachmentId` | حذف (المالك) — يتطلب ترويسة `Authorization` (لا رموز وسائط) |

**قاعدة الاتّساق بين الملف والرسالة**: لا يُقبل مرفق مشفّر في محادثة عادية (`plaintext_conversation_rejects_encrypted_files`) ولا مرفق مقروء في محادثة مشفّرة (`encrypted_conversation_requires_encrypted_files`) — الحالتان `400 validation_error`.
| GET | `/files/allowed-types` \| `/files/usage` | الأنواع المسموحة والاستهلاك |

**لماذا يوجد رمز وسائط منفصل؟** المتصفح لا يستطيع إرسال ترويسة `Authorization` مع `<img>` أو
`<video>` أو رابط تنزيل، ووضع رمز الوصول (15 دقيقة، يصلح لكل الـAPI) في سلسلة استعلام يسرّبه
إلى سجلات الخادم. لذلك:

1. العميل يطلب `POST /api/auth/media-token` ← JWT بخمس دقائق، جمهور `sovereign-media`،
   و`scope: files:read` فقط.
2. يبني `<img src="/api/files/<id>?token=<media>">` (الويب يفعل ذلك تلقائياً في `lib/media.ts`
   ويجدّده قبل انتهائه؛ الجوال يرسل الترويسة مباشرة عبر `api.mediaSource()` لأنه يستطيع ذلك).
3. الخادم يتحقق من الرمز **ومن الجلسة** في كل طلب؛ إلغاء الجلسة يُبطل الرموز الممنوحة خلال ثوانٍ.
4. رمز الوسائط لا يصلح لأي نقطة نهاية أخرى (مُختبر: `GET /api/users/me` برمز وسائط → 401).
| GET | `/uploads/pending` | مرفقات لم تُربط برسالة (تنظيف) |

الحدود: 50MB افتراضياً، فحص نوع حقيقي (magic bytes) وحجب الأنواع التنفيذية، وتجزئة SHA-256 لمنع
التكرار داخل المحادثة.

## الشبكة الاجتماعية

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| GET | `/feed?tab=following\|for-you\|trending&limit=&cursor=` | `{items, nextCursor}` — زمني بالكامل |
| POST | `/posts` | `{body?, visibility, attachmentIds?, replyToId?, quoteOfId?}` |
| GET/DELETE | `/posts/:postId` | قراءة/حذف |
| POST/DELETE | `/posts/:postId/like` | إعجاب |
| POST | `/posts/:postId/repost` | إعادة نشر (`{reposted: true/false}`) |
| GET/POST | `/posts/:postId/comments` | التعليقات (POST = منشور بـ`replyToId`) |
| GET | `/posts/:postId/likes` | قائمة المعجبين |
| GET | `/hashtags/trending` \| `/hashtags/:tag` | وسوم (آخر 7 أيام للمتداولة) |
| GET/POST | `/notifications` \| `/notifications/read` | `{items, unread}` / `{ids?}` لتعليم الكل |

## القنوات

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| POST | `/channels` | `{name, slug?, description?, visibility}` |
| GET | `/channels/discover?q=&limit=` \| `/channels/subscribed` | استكشاف / قنواتي |
| GET | `/channels/:slug` | `{channel, members}` |
| PATCH | `/channels/:channelId` | تعديل (مالك/مشرف) |
| POST/DELETE | `/channels/:channelId/subscribe` | اشتراك/مغادرة |
| POST/GET | `/channels/:channelId/invites` + `DELETE .../:inviteId` | دعوات `{maxUses, ttlHours}` |
| POST | `/channels/join/:code` | قبول الدعوة |
| GET/POST | `/channels/:channelId/posts` | المنشورات (٪+) |
| POST/DELETE | `/channels/:channelId/posts/:postId[/pin]` | تثبيت/حذف |
| POST | `/channels/:channelId/members/:userId/role` | `{role: admin\|moderator\|subscriber}` — يرفض تغيير دور المالك |
| GET | `/channels/:channelId/audit` | سجل تدقيق **مخصّص للقناة** (مالك/مشرف فقط): من رقّى/حذف/أنشأ دعوة ومتى. السجل العام `/moderation/audit` يبقى للمشرفين على مستوى المنصة |
| — | — | ملاحظة: إنشاء قناة باسم عربي بلا `slug` يولّد رابطاً لاتينياً تلقائياً؛ و`slug` صريح مكرر يُرفض بـ`slug_taken` |

## المكالمات

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| GET | `/calls/capabilities` | `{oneToOneAudio, oneToOneVideo, groupCalls, turnConfigured, ...}` — صادق بشأن ما هو مُعدّ |
| GET | `/calls/ice` | `{iceServers}` مع بيانات TURN مؤقتة (HMAC) |
| POST | `/calls` | `{conversationId, kind: audio\|video}` → 201 `{call, iceServers}` |
| POST | `/calls/:callId/answer` \| `/decline` \| `/end` | تغييرات الحالة |
| GET | `/calls/:callId` \| `/calls/history` \| `/calls/ringing` | التفاصيل/السجل/الرنين الحالي |
| GET/POST | `/live-rooms`, `/live-rooms/:roomId/join` | غرف مباشرة (تتطلب LiveKit؛ 503 بدونه) |

## الإشراف

| الطريقة | المسار | الوصف |
| --- | --- | --- |
| POST | `/reports` | `{targetType: user\|post\|message\|channel, targetId, reason, details?}` (201/200 عند التكرار) |
| GET | `/moderation/reports?status=` | طابور الإشراف (staff فقط) |
| POST | `/moderation/reports/:id/resolve` | `{action, notes?}` → قرار + تدقيق + إشعار للمُبلِّغ |
| GET | `/moderation/audit` | سجل التدقيق (staff فقط) |

## الوقت الحقيقي `/ws`

المصافحة: `POST /api/auth/realtime-ticket` ثم `wss://host/ws?ticket=...`.

إطارات العميل: `hello`, `ping`, `subscribe`, `unsubscribe`, `message.send`, `message.edit`,
`message.delete`, `message.read`, `message.delivered`, `typing`, `presence.subscribe`, `call.signal`.

إطارات الخادم: `hello/ready`, `pong`, `message`, `message.updated`, `message.deleted`, `receipt`,
`typing`, `presence`, `call.signal`, `notification`, `ack`, `error`.

`call.signal`:
```jsonc
// من العميل
{ "t": "call.signal", "rid": "…", "callId": "…",
  "signal": { "type": "offer"|"answer"|"candidate"|"renegotiate"|"bye", "sdp"?: "…", "candidate"?: {…} } }
// من الخادم (يُرحّل كما هو، بدون فكّ أو تعديل)
{ "t": "call.signal", "callId": "…", "fromUserId": "…", "signal": { … } }
```

أكواد إغلاق الـWebSocket: `4401` غير مصادق، `4403` محظور، `4429` اتصالات كثيرة، `4400` عدم تطابق
إصدار البروتوكول، `4408` مشترك بطيء.

## الصحة

| المسار | الوصف |
| --- | --- |
| `GET /api/health` | `{status, uptime, checks: {database, cache, storage}}` — يُستخدم في فحوص الحاويات |
| `GET /api/health/live` | فحص حياة بسيط (بدون تبعيات) |
