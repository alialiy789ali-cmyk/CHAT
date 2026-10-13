# النسخ الاحتياطي والاستعادة · Backup & restore

الأهداف: **RPO ≤ 24 ساعة** (نسخة يومية + WAL عند الحاجة) و **RTO ≤ 30 دقيقة** لخادم واحد.
كل النسخ تُشفَّر ويُحتفظ بها خارج الخادم.

ما يجب نسخه:

| العنصر | لماذا | الأداة |
| --- | --- | --- |
| قاعدة البيانات (PostgreSQL) | الحسابات، الرسائل، المنشورات، القنوات، السجلات | `pg_dump -Fc` |
| كائنات الملفات | المرفقات والصور (S3/MinIO أو `var/storage`) | `mc mirror` أو `rsync` |
| `.env` والأسرار | بدونها لا يمكن فك تشفير أسرار TOTP المؤقتة ولا تشغيل الخدمة | نسخة مشفّرة يدوياً (خارج Git) |

**لا يُنسخ**: `node_modules`, `.next`, سجلات الحاويات.

## 1) نسخة احتياطية كاملة

```bash
infra/scripts/backup.sh /var/backups/sovereign
```

السكربت يقوم بـ:

1. `pg_dump -Fc` عبر حاوية postgres → `db-<timestamp>.dump` (نسخة مُتسقة منطقية).
2. مزامنة ملفات التخزين: MinIO (`mc mirror`) أو دليل محلي (`rsync`).
3. كتابة `manifest.txt` (الإصدار، عدد الجداول، بصمات SHA-256) وملف `.sha256` لكل أرشيف.
4. (اختياري) فك تشفير/تشفير الناتج إذا ضُبط `BACKUP_GPG_RECIPIENT`.

جدولة يومية:

```bash
0 2 * * * /opt/sovereign/infra/scripts/backup.sh /var/backups/sovereign >> /var/log/sovereign-backup.log 2>&1
```

نقل خارج الخادم (إلزامي للاستعادة الحقيقية):

```bash
# S3 متوافق تملكه
aws --endpoint-url https://s3.example.com s3 sync /var/backups/sovereign s3://sovereign-backups/$(hostname)/
# أو خادم آخر
rsync -az --delete /var/backups/sovereign/ backup@backup-host:/srv/sovereign/
```

## 2) استعادة كاملة

```bash
# 1) أوقف الخدمات التي تكتب لقاعدة البيانات
docker compose -f infra/docker-compose.yml stop api web

# 2) استعد قاعدة البيانات (يُعاد إنشاء القاعدة من الصفر)
infra/scripts/restore.sh /var/backups/sovereign/db-2026-10-13T020000Z.dump

# 3) استعد الملفات
infra/scripts/restore.sh --storage /var/backups/sovereign/storage-2026-10-13T020000Z.tar.gz

# 4) شغّل الخدمات وتحقق
docker compose -f infra/docker-compose.yml start api web
curl -fsS https://chat.example.com/api/health
docker compose -f infra/docker-compose.yml exec api npm run smoke --silent
```

`restore.sh` يطلب تأكيداً كتابياً (`RESTORE`) لمنع الحذف بالخطأ، ويأخذ نسخة أمان من الحالة
الحالية قبل الكتابة (`pre-restore-<timestamp>.dump`).

## 3) استعادة انتقائية (بلا توقف كامل)

```bash
# استخرج جدولاً أو صفوفاً من النسخة
pg_restore -l db.dump > tables.txt                 # اطبع المحتويات
pg_restore -a -t messages db.dump | psql ...
```

مثال عملي: استرجاع رسالة حُذفت ناعماً:

```sql
-- استخراج الصف من النسخة إلى جدول مؤقت ثم:
update messages set deleted_at = null, body = restored.body
from restored_messages restored where messages.id = restored.id;
```

## 4) اختبار الاستعادة (لا تُعد النسخة موثوقة قبل الاختبار)

```bash
# قاعدة بيانات اختبارية منفصلة
docker run --rm -d --name restore-test -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:16-alpine
createdb -h localhost -p 55433 -U postgres restore_test
pg_restore -h localhost -p 55433 -U postgres -d restore_test --clean --if-exists db.dump
psql -h localhost -p 55433 -U postgres -d restore_test -c \
  "select (select count(*) from users) users, (select count(*) from messages) messages, (select count(*) from posts) posts;"
```

المعتاد أن يطابق العدد قيم يوم النسخة. نفّذ هذا الاختبار **شهرياً** وسجّل النتيجة مع التاريخ
والمدة في `docs/feature-log.md`.

## 5) سيناريوهات أعطال

| السيناريو | الإجراء | التوقّع |
| --- | --- | --- |
| تلف جدول/خطأ مستخدم | استعادة انتقائية من نسخة الأمس | لا توقف عام |
| فقدان القرص | خادم جديد + نسخة كاملة + `.env` + الشهادات | ≤30 دقيقة |
| حذف حساب بالخطأ | استعادة كاملة على بيئة جانبية + تصدير صفوفه | حسب الحالة |
| تلف WAL | نسخة يومية كاملة (بدون PITR) | خسارة ≤24 ساعة |

## 6) تحسين المستقبل

- **PITR**: فعّل `archive_mode=on` + `archive_command` إلى تخزين خارجي، ثم RPO دقائق.
- **نسخ متزامنة**: `pg_basebackup` دوري مع `--wal-method=stream`.
- **اختبار آلي**: سكربت CI شهري يشغّل `backup.sh` على قاعدة بيانات تجريبية ثم `restore.sh` ويتحقق من الأعداد.
