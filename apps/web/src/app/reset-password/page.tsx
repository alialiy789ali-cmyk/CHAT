'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button, Field } from '@/components/ui';

/**
 * Password reset. In development the API returns the reset token directly (mail adapter
 * is the console); in production the token only travels by email, so the field stays empty.
 */

export default function ResetPasswordPage() {
  const [stage, setStage] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get('token');
    if (fromLink) {
      setToken(fromLink);
      setStage('confirm');
    }
  }, []);

  async function request(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.post<{ sent: boolean; devToken?: string }>('/api/auth/password/request-reset', { email });
      setMessage('إذا كان البريد مسجلاً فستصلك رسالة لإعادة التعيين.');
      if (result.devToken) {
        setToken(result.devToken);
        setStage('confirm');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.payload.message : 'تعذّر إرسال الطلب.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password/reset', { token, newPassword: password });
      setMessage('تم تعيين كلمة مرور جديدة. يمكنك تسجيل الدخول الآن.');
    } catch {
      setError('الرمز غير صالح أو منتهي الصلاحية.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-6">
      <div className="card w-full space-y-4 p-6">
        <h1 className="text-2xl font-bold">استعادة كلمة المرور</h1>

        {stage === 'request' ? (
          <form onSubmit={request} className="space-y-3">
            <Field label="البريد الإلكتروني" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            <Button type="submit" loading={busy} className="w-full">
              إرسال رابط الاستعادة
            </Button>
          </form>
        ) : (
          <form onSubmit={confirm} className="space-y-3">
            <Field label="رمز الاستعادة" required value={token} onChange={(event) => setToken(event.target.value)} />
            <Field
              label="كلمة المرور الجديدة"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint="10 أحرف على الأقل مع رقم"
            />
            <Button type="submit" loading={busy} className="w-full" disabled={password.length < 10}>
              تعيين كلمة المرور
            </Button>
          </form>
        )}

        {message && <p className="text-sm" style={{ color: 'var(--success)' }}>{message}</p>}
        {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

        <p className="text-center text-sm">
          <Link className="underline" href="/login">
            رجوع لتسجيل الدخول
          </Link>
        </p>
      </div>
    </main>
  );
}
