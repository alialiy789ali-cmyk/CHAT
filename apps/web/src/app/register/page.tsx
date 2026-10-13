'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { Button, Field } from '@/components/ui';
import { useT } from '@/lib/i18n';

/** Client-side mirror of the server's username/password policy (the server re-validates). */
const USERNAME_RE = /^[a-z][a-z0-9_]{2,23}$/;

export default function RegisterPage() {
  const { register } = useSession();
  const tr = useT();
  const [form, setForm] = useState({ username: '', email: '', password: '', displayName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usernameError =
    form.username && !USERNAME_RE.test(form.username.toLowerCase())
      ? '3–24 حرفاً، تبدأ بحرف، وتقبل الأرقام والشرطة السفلية فقط.'
      : null;
  const passwordError =
    form.password && (form.password.length < 10 || !/[0-9]/.test(form.password))
      ? '10 أحرف على الأقل مع رقم واحد.'
      : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        username: form.username.toLowerCase(),
        email: form.email.toLowerCase(),
        password: form.password,
        displayName: form.displayName || form.username,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const map: Record<string, string> = {
          username_taken: 'اسم المستخدم محجوز.',
          email_taken: 'البريد الإلكتروني مستخدم بالفعل.',
          validation_error: 'تحقق من صحة الحقول.',
          registration_closed: 'التسجيل مغلق في هذا الخادم.',
        };
        const detail = Array.isArray(err.payload.details) && err.payload.details.length > 0
          ? (err.payload.details as Array<{ path: string; message: string }>)[0]
          : null;
        setError(map[err.payload.code] ?? (detail ? `الحقل ${detail.path}: ${detail.message}` : 'تعذّر إنشاء الحساب.'));
      } else {
        setError('تعذّر الاتصال بالخادم.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-6">
      <form onSubmit={submit} className="card w-full space-y-4 p-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold">{tr('signUp')}</h1>
          <p className="muted text-sm">أنشئ حسابك على هذا الخادم — بياناتك تبقى هنا.</p>
        </div>

        <Field
          label={tr('username')}
          name="username"
          required
          autoComplete="username"
          value={form.username}
          error={usernameError}
          onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })}
          placeholder="khalid_2026"
        />
        <Field
          label={tr('displayName')}
          name="displayName"
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
          placeholder="خالد العامري"
        />
        <Field
          label={tr('email')}
          name="email"
          type="email"
          required
          autoComplete="email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <Field
          label={tr('password')}
          name="password"
          type="password"
          required
          autoComplete="new-password"
          value={form.password}
          error={passwordError}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        <Button type="submit" loading={busy} className="w-full" disabled={Boolean(usernameError || passwordError)}>
          {tr('signUp')}
        </Button>

        <p className="text-center text-sm">
          لديك حساب؟{' '}
          <Link className="underline" href="/login">
            {tr('signIn')}
          </Link>
        </p>
      </form>
    </main>
  );
}
