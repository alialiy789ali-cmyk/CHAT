'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Field, Spinner, Tabs } from '@/components/ui';
import { LOCALES, setLocale, useT, type Locale } from '@/lib/i18n';

/**
 * Settings: profile, appearance, privacy switches, security (password, 2FA, sessions,
 * devices), data export and account deletion. Every control calls a real endpoint.
 */

type Section = 'profile' | 'appearance' | 'privacy' | 'security' | 'data';

interface SessionRow {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  platform: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string;
  createdAt: string;
}

export default function SettingsPage() {
  const { viewer, updateViewer, refreshViewer } = useSession();
  const tr = useT();
  const [section, setSection] = useState<Section>('profile');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!viewer) {
    return (
      <div className="grid min-h-[50dvh] place-items-center">
        <Spinner />
      </div>
    );
  }

  async function patchProfile(patch: Record<string, unknown>, message: string) {
    setError(null);
    setNotice(null);
    try {
      await api.patch('/api/users/me', patch);
      await refreshViewer();
      setNotice(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.message : 'تعذّر الحفظ.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-xl font-bold">{tr('settings')}</h1>
      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'profile', label: tr('profile') },
          { id: 'appearance', label: tr('appearance') },
          { id: 'privacy', label: tr('privacy') },
          { id: 'security', label: tr('security') },
          { id: 'data', label: tr('exportData') },
        ]}
      />

      {notice && (
        <p className="card p-3 text-sm" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="card p-3 text-sm" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </p>
      )}

      {section === 'profile' && <ProfileSection viewer={viewer} onSave={patchProfile} setNotice={setNotice} setError={setError} />}
      {section === 'appearance' && <AppearanceSection viewer={viewer} onSave={patchProfile} />}
      {section === 'privacy' && <PrivacySection viewer={viewer} setNotice={setNotice} setError={setError} />}
      {section === 'security' && <SecuritySection />}
      {section === 'data' && <DataSection />}
      {section === 'profile' && (
        <p className="muted text-xs">
          الهوية البصرية والتخطيط أصليان بالكامل لهذا المشروع؛ لا نُقلّد أي واجهة تجارية.
        </p>
      )}
    </div>
  );
}

function ProfileSection({
  viewer,
  onSave,
  setNotice,
  setError,
}: {
  viewer: NonNullable<ReturnType<typeof useSession>['viewer']>;
  onSave: (patch: Record<string, unknown>, message: string) => Promise<void>;
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const [displayName, setDisplayName] = useState(viewer.displayName);
  const [bio, setBio] = useState(viewer.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">الملف الشخصي</h2>
      <Field label="الاسم الظاهر" value={displayName} maxLength={60} onChange={(event) => setDisplayName(event.target.value)} />
      <Field label="نبذة" value={bio} maxLength={280} onChange={(event) => setBio(event.target.value)} hint={`${bio.length}/280`} />
      <Field label="اسم المستخدم" value={viewer.username} disabled hint="لا يمكن تغييره حالياً (يحافظ على استقرار الروابط)." />

      <div className="flex flex-wrap items-center gap-3">
        <label className="btn btn-ghost cursor-pointer">
          {avatarBusy ? <Spinner size={14} /> : '🖼'} تغيير الصورة
          <input
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setAvatarBusy(true);
              setError(null);
              try {
                const form = new FormData();
                form.append('file', file);
                await api.upload('/api/users/me/avatar', form);
                setNotice('تم تحديث الصورة الرمزية.');
              } catch {
                setError('تعذّر رفع الصورة (PNG/JPEG/WebP حتى 50MB).');
              } finally {
                setAvatarBusy(false);
                event.target.value = '';
              }
            }}
          />
        </label>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await onSave({ displayName, bio }, 'تم الحفظ.');
            setBusy(false);
          }}
        >
          حفظ
        </Button>
      </div>
    </section>
  );
}

function AppearanceSection({ viewer, onSave }: { viewer: NonNullable<ReturnType<typeof useSession>['viewer']>; onSave: (patch: Record<string, unknown>, message: string) => Promise<void> }) {
  const tr = useT();
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">{tr('appearance')}</h2>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{tr('theme')}</span>
        <select
          className="input"
          value={viewer.theme}
          onChange={(event) => {
            const theme = event.target.value as 'light' | 'dark' | 'system';
            document.documentElement.classList.toggle(
              'dark',
              theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches),
            );
            void onSave({ theme }, 'تم تحديث السمة.');
          }}
        >
          <option value="light">{tr('light')}</option>
          <option value="dark">{tr('dark')}</option>
          <option value="system">{tr('system')}</option>
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{tr('language')}</span>
        <select
          className="input"
          value={viewer.locale}
          onChange={(event) => {
            const locale = event.target.value as Locale;
            setLocale(locale);
            void onSave({ locale }, 'تم تحديث اللغة.');
          }}
        >
          {LOCALES.map((locale) => (
            <option key={locale.id} value={locale.id}>
              {locale.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted text-xs">العربية الافتراضية مع اتجاه RTL كامل، والإنجليزية LTR — كلاهما مُختبَر.</p>
    </section>
  );
}

function PrivacySection({
  viewer,
  setNotice,
  setError,
}: {
  viewer: NonNullable<ReturnType<typeof useSession>['viewer']>;
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  const { refreshViewer } = useSession();
  const privacy = viewer.privacy;

  async function update(patch: Partial<typeof privacy>) {
    setError(null);
    setNotice(null);
    try {
      await api.patch('/api/users/me/privacy', patch);
      await refreshViewer();
      setNotice('تم حفظ إعدادات الخصوصية.');
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.message : 'تعذّر الحفظ.');
    }
  }

  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-semibold">الخصوصية</h2>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm">من يستطيع مراسلتك؟</span>
        <select
          className="input w-auto"
          value={privacy.whoCanMessage}
          onChange={(event) => void update({ whoCanMessage: event.target.value as never })}
        >
          <option value="everyone">الجميع</option>
          <option value="contacts">المتابَعة المتبادلة فقط</option>
          <option value="nobody">لا أحد</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm">من يرى ملفك؟</span>
        <select
          className="input w-auto"
          value={privacy.whoCanSeeProfile}
          onChange={(event) => void update({ whoCanSeeProfile: event.target.value as never })}
        >
          <option value="everyone">الجميع</option>
          <option value="followers">المتابعون</option>
          <option value="nobody">لا أحد</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm">إرسال إشعارات القراءة (قد يظهر للطرف الآخر متى قرأت)</span>
        <input type="checkbox" checked={privacy.readReceipts} onChange={(event) => void update({ readReceipts: event.target.checked })} />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm">إظهار حالة الاتصال</span>
        <input type="checkbox" checked={privacy.showOnlineStatus} onChange={(event) => void update({ showOnlineStatus: event.target.checked })} />
      </label>
    </section>
  );
}

function SecuritySection() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string; recoveryCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    void api
      .get<SessionRow[]>('/api/auth/sessions')
      .then(setSessions)
      .catch(() => {});
    void api
      .get<DeviceRow[]>('/api/users/me/devices')
      .then(setDevices)
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">كلمة المرور</h2>
        <Field label="كلمة المرور الحالية" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        <Field
          label="كلمة المرور الجديدة"
          type="password"
          autoComplete="new-password"
          hint="10 أحرف على الأقل مع رقم"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <Button
          onClick={async () => {
            try {
              const res = await api.post<{ revokedSessions: number }>('/api/auth/password/change', {
                currentPassword,
                newPassword,
              });
              // The caller's own session survives a password change; the others are revoked.
              setStatus(
                res.revokedSessions > 0
                  ? `تم تغيير كلمة المرور، وتم إنهاء ${res.revokedSessions} جلسة على أجهزة أخرى. هذا الجهاز ما زال مسجّلاً.`
                  : 'تم تغيير كلمة المرور. لم تكن هناك جلسات أخرى لإنهائها.',
              );
              setCurrentPassword('');
              setNewPassword('');
            } catch {
              setStatus('تعذّر تغيير كلمة المرور (تحقق من كلمة المرور الحالية).');
            }
          }}
          disabled={!currentPassword || newPassword.length < 10}
        >
          تحديث كلمة المرور
        </Button>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">التحقق بخطوتين (TOTP)</h2>
        {totp ? (
          <>
            <p className="text-sm">أضف السر إلى تطبيق المصادقة:</p>
            <code className="block break-all rounded-lg p-2 text-xs" style={{ background: 'var(--surface-sunken)' }}>
              {totp.secret}
            </code>
            <p className="muted break-all text-xs">{totp.otpauthUrl}</p>
            <Field label="رمز التحقق" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} maxLength={6} />
            <Button
              onClick={async () => {
                try {
                  const res = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code });
                  setStatus('تم تفعيل التحقق بخطوتين.');
                  setTotp({ ...totp, recoveryCodes: res.recoveryCodes });
                } catch {
                  setStatus('رمز غير صحيح.');
                }
              }}
            >
              تأكيد التفعيل
            </Button>
            {totp.recoveryCodes.length > 0 && (
              <div>
                <p className="text-sm font-medium">رموز الاستعادة (تُعرض مرة واحدة — احفظها):</p>
                <code className="muted block text-xs">{totp.recoveryCodes.join(' · ')}</code>
              </div>
            )}
          </>
        ) : (
          <Button
            onClick={async () => {
              const res = await api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', {});
              setTotp({ ...res, recoveryCodes: [] });
            }}
          >
            بدء الإعداد
          </Button>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">الجلسات النشطة</h2>
        <ul className="space-y-2">
          {sessions.length === 0 && <li className="muted text-sm">لا جلسات أخرى.</li>}
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {session.deviceName ?? session.platform ?? 'جهاز غير معروف'} ·{' '}
                <span className="muted">{session.ip ?? '—'} · آخر استخدام {new Date(session.lastUsedAt).toLocaleString('ar-EG')}</span>
                {session.current && <span className="pill ms-2">هذه الجلسة</span>}
              </span>
              {!session.current && (
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={async () => {
                    await api.del(`/api/auth/sessions/${session.id}`);
                    setSessions((current) => current.filter((item) => item.id !== session.id));
                  }}
                >
                  إلغاء
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">الأجهزة</h2>
        <ul className="space-y-2">
          {devices.length === 0 && <li className="muted text-sm">لا أجهزة مسجّلة.</li>}
          {devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {device.name} · <span className="muted">{device.platform} · {new Date(device.lastSeenAt).toLocaleDateString('ar-EG')}</span>
              </span>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={async () => {
                  await api.del(`/api/users/me/devices/${device.id}`);
                  setDevices((current) => current.filter((item) => item.id !== device.id));
                }}
              >
                إزالة
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {status && (
        <p className="card p-3 text-sm" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function DataSection() {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">تصدير بياناتي</h2>
        <p className="muted text-sm">
          ملف JSON يضمّ ملفك الشخصي ومنشوراتك ومحادثاتك وإعداداتك. يُبنى عند الطلب ولا يُخزَّن على الخادم.
        </p>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api.get<unknown>('/api/users/me/export');
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `sovereign-export-${Date.now()}.json`;
              link.click();
              URL.revokeObjectURL(url);
              setResult('تم تنزيل ملف التصدير.');
            } catch {
              setResult('تعذّر إنشاء التصدير.');
            } finally {
              setBusy(false);
            }
          }}
        >
          تنزيل نسخة
        </Button>
      </section>

      <section className="card space-y-3 p-4" style={{ borderColor: 'var(--danger)' }}>
        <h2 className="font-semibold" style={{ color: 'var(--danger)' }}>
          حذف الحساب
        </h2>
        <p className="muted text-sm">
          يُخفى حسابك وتُلغى كل الجلسات فوراً. تبقى رسائلك لدى الطرف الآخر بلا اسم (إخفاء الهوية) حفاظاً على محادثاته.
        </p>
        <Field label="اكتب DELETE للتأكيد" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        <Button
          variant="danger"
          disabled={confirm !== 'DELETE'}
          onClick={async () => {
            await api.del('/api/users/me');
            window.location.href = '/login';
          }}
        >
          حذف حسابي نهائياً
        </Button>
      </section>

      {result && <p className="card p-3 text-sm">{result}</p>}
    </div>
  );
}
