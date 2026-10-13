'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { Button, Field } from '@/components/ui';
import { useT } from '@/lib/i18n';

export default function LoginPage() {
  const { login } = useSession();
  const tr = useT();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier, password, needsTotp ? totp : undefined);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.payload.code === 'totp_required') {
          setNeedsTotp(true);
          setError('أدخل رمز التحقق من تطبيق المصادقة.');
        } else if (err.payload.code === 'rate_limited') {
          setError('محاولات كثيرة. الرجاء الانتظار قليلاً ثم إعادة المحاولة.');
        } else {
          setError('بيانات الدخول غير صحيحة.');
        }
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
          <h1 className="text-2xl font-bold">{tr('signIn')}</h1>
          <p className="muted text-sm">{tr('tagline')}</p>
        </div>

        <Field
          label={tr('username')}
          name="identifier"
          autoComplete="username"
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="layla"
        />
        <Field
          label={tr('password')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {needsTotp && (
          <Field
            label={tr('twoFactorCode')}
            name="totp"
            inputMode="numeric"
            maxLength={6}
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, ''))}
            hint="6 أرقام من تطبيق المصادقة"
          />
        )}

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        <Button type="submit" loading={busy} className="w-full">
          {tr('signIn')}
        </Button>

        <div className="flex items-center justify-between text-sm">
          <Link className="underline" href="/register">
            {tr('signUp')}
          </Link>
          <Link className="muted underline" href="/reset-password">
            نسيت كلمة المرور؟
          </Link>
        </div>

        <p className="muted rounded-xl p-3 text-xs" style={{ background: 'var(--surface-sunken)' }}>
          حسابات تجريبية: <code>layla</code> / <code>omar</code> — كلمة المرور <code>Sovereign-Demo-2026</code>
        </p>
      </form>
    </main>
  );
}
