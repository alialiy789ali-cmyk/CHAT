# النشر على خادم · Server deployment

الهدف: نشر كامل على خادم واحد تملكه، مع TLS، ونسخ احتياطي مجدول، ومراقبة أساسية.

## 1) المتطلبات

- خادم Linux (Ubuntu 22.04/24.04 أو Debian 12) بذاكرة ≥ 4GB وقرص ≥ 40GB SSD.
- نطاق (Domain) يشير بسجل `A`/`AAAA` إلى عنوان الخادم، مثل `chat.example.com`.
- Docker Engine 24+ و Docker Compose v2.
- منافذ مفتوحة: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `5349/tcp+udp`,
  `49160-49200/udp` (نطاق TURN relay)، و`22/tcp` للإدارة.

```bash
# تجهيز الخادم
sudo apt update && sudo apt install -y docker.io docker-compose-v2 ufw
sudo ufw allow 22,80,443,3478,5349/tcp
sudo ufw allow 3478,5349,49160:49200/udp
sudo ufw enable
```

## 2) الإعداد

```bash
git clone <repo> /opt/sovereign && cd /opt/sovereign
cp .env.example .env

# كلمات مرور عشوائية قوية
sed -i "s|change-me-in-production|$(openssl rand -base64 24)|g" .env

# الأسرار الإلزامية (≥32 حرفاً لكل سر)
for k in ACCESS_TOKEN_SECRET REFRESH_TOKEN_SECRET REALTIME_TICKET_SECRET FIELD_ENCRYPTION_KEY SESSION_SECRET; do
  printf '%s=%s\n' "$k" "$(openssl rand -base64 48)" >> .env
done

# املأ: DOMAIN، CORS_ORIGINS، PUBLIC_API_URL، بيانات SMTP، وRTC_TURN_*
$EDITOR .env
```

## 3) TLS

الطريقة الأبسط (Let's Encrypt عبر certbot على المضيف، مع مشاركة الشهادات مع الحاوية):

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d chat.example.com --agree-tos -m admin@example.com
mkdir -p infra/nginx/certs
sudo cp /etc/letsencrypt/live/chat.example.com/fullchain.pem infra/nginx/certs/
sudo cp /etc/letsencrypt/live/chat.example.com/privkey.pem   infra/nginx/certs/
sudo chown -R $USER infra/nginx/certs
```

بديل كامل داخل Docker: استخدم `nginxproxy/acme-companion` أو `caddy` بدل nginx.
جدّد الشهادات آلياً:

```bash
echo '0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/chat.example.com/*.pem /opt/sovereign/infra/nginx/certs/ && docker compose -f /opt/sovereign/infra/docker-compose.yml exec nginx nginx -s reload' | sudo crontab -
```

## 4) التشغيل

```bash
cd /opt/sovereign
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps
curl -fsS https://chat.example.com/api/health | head
```

هجرات قاعدة البيانات تُنفَّذ تلقائياً عند إقلاع الخادم (`createRuntime` يشغّل `migrate`)،
ويمكن تشغيلها يدوياً:

```bash
# مُنفَّذ ومُختبَر محلياً: يطبّق الهجرات ثم يخرج بكود 0 دون فتح منفذ
docker compose -f infra/docker-compose.yml exec api node dist/index.js --migrate-only
```

### إعداد TURN للاتصال خلف شبكات مقيّدة

```bash
# في .env
RTC_TURN_URLS=turn:chat.example.com:3478?transport=udp,turns:chat.example.com:5349?transport=tcp
RTC_TURN_SECRET=<نفس static-auth-secret في infra/coturn/turnserver.conf>
```

ثم `docker compose up -d coturn api nginx` والتحقق:

```bash
docker compose -f infra/docker-compose.yml exec api node -e \
  "fetch('http://127.0.0.1:8787/api/calls/capabilities').then(r=>r.json()).then(c=>console.log(c.turnConfigured))"
```

## 5) الحساب الأول (المشرف)

```bash
# سجّل حسابك من الواجهة، ثم:
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U sovereign -d sovereign -c \
  "update users set role='admin' where username='<اسمك>';"
```

أو ضع بريدك في `ADMIN_EMAILS` **قبل** التسجيل ليُرقّى تلقائياً.

## 6) المراقبة والنسخ والترقية

```bash
# سجلّات
docker compose -f infra/docker-compose.yml logs -f --tail=200 api

# نسخ احتياطي (يومي عبر cron)
0 2 * * * /opt/sovereign/infra/scripts/backup.sh /var/backups/sovereign >> /var/log/sovereign-backup.log 2>&1

# ترقية
cd /opt/sovereign && git pull && docker compose -f infra/docker-compose.yml up -d --build
```

مؤشرات يجب مراقبتها: `GET /api/health`، معدل أخطاء 5xx في سجل nginx، حجم `postgres-data`،
وعدد الاتصالات في `/ws` (سجل الخادم). للتوسّع الأفقي: `docker compose up -d --scale api=3`
بشرط `CACHE_DRIVER=redis` (مُعدّ افتراضياً في Compose) وموازن يحتفظ بالاتصال (nginx `ip_hash`
أو sticky للـ`/ws`).

### مؤشرات Prometheus

`GET /api/metrics` يصدر الصيغة النصية المعروفة (Prometheus text 0.0.4) — **لكنه مُعطَّل افتراضياً**:
بدون `METRICS_TOKEN` يعيد 404، فلا تكشف نشرة لم تُضبط أي شيء. عند ضبط الرمز يلزم تمريره في
`x-metrics-token` (أو `?token=`)، والمقارنة ثابتة الزمن.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sovereign
    scrape_interval: 15s
    metrics_path: /api/metrics
    static_configs:
      - targets: ['127.0.0.1:8787']
    authorization:
      credentials_file: /etc/prometheus/sovereign-metrics-token
```

ما يُقاس: `sovereign_http_requests_total{method,route,status}` بمعدل الطلبات والأخطاء حسب **نمط
المسار** (مثل `/api/files/:attachmentId`) لا حسب الرابط الكامل، و`sovereign_http_request_duration_seconds`
(هيستوجرام buckets زمن الاستجابة)، و`sovereign_realtime_connections` (اتصالات WebSocket الحيّة)،
و`sovereign_db_pool_{total,idle,waiting}`، وذاكرة/عمر العملية. لا يحمل أي مؤشر معرّفات مستخدمين أو
محادثات — تكبير الكارديناليتي وتسريب البيانات الوصفية مرفوضان بالتصميم.

تنبيهات مقترحة: `rate(sovereign_http_requests_total{status=~"5.."}[5m]) > 0.1`،
`histogram_quantile(0.95, rate(sovereign_http_request_duration_seconds_bucket[5m])) > 1`،
`sovereign_db_pool_waiting > 0` لمدة دقيقتين، و`sovereign_realtime_connections` عند الصفر في ساعات
الذروة (مؤشر انقطاع وسيط).

## 7) تقوية (Hardening) موصى بها

- SSH بمفاتيح فقط، وتعطيل دخول root: `PermitRootLogin no`.
- `fail2ban` على sshd وnginx.
- نسخ احتياطي خارج الخادم (S3 متوافق تملكه) — النسخ على نفس القرص ليست نسخة.
- تحديث دوري: `apt upgrade` أسبوعياً، و`docker compose pull` شهرياً.
- مراقبة المنافذ المكشوفة: `ss -lntup` — يجب ألا يظهر 8787/3000 للعالم (nginx فقط).

## 8) ما لم يُختبر هنا بصراحة

ملفات Compose وnginx وcoturn **لم تُشغَّل فعلياً** في بيئة التطوير (بلا Docker). سجّل أي تصحيح
لازم أثناء النشر الفعلي في `docs/feature-log.md`. الخطوات أعلاه مبنية على إعدادات المشروع
الفعلية (أسماء المتغيرات، المنافذ، مسارات الشهادات) وليست افتراضية.
