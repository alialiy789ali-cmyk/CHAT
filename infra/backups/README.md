# نسخ احتياطي محلي · Local backup drop folder

هذا المجلد هو الوجهة الافتراضية لـ`infra/scripts/backup.sh` عند التشغيل على الخادم:

```bash
BACKUP_DIR=infra/backups infra/scripts/backup.sh
```

- يُنشئ `backup.sh` فيه ملفات `db-<UTC>.dump` و`storage-<UTC>.tar.gz` و`manifest-<UTC>.txt`
  (يتضمن SHA-256 لكل ملف وعدد الصفوف) ثم يحذف ما تجاوز `RETENTION_DAYS`.
- المحتوى **مستبعد من Git** (انظر `.gitignore`): النسخ تحتوي بيانات مستخدمين حقيقية،
  ويجب دفعها إلى مخزن خارج الخادم (`rclone`/`restic`/S3) لا إلى المستودع.
- خطة الاستعادة الكاملة: `docs/backup-restore.md`.
