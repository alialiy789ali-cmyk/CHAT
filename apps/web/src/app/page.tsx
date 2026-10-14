'use client';

import Link from 'next/link';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { Spinner } from '@/components/ui';

/** Landing page: explains what the platform is, and routes authenticated users to the app. */

export default function LandingPage() {
  const { status } = useSession();
  const tr = useT();

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-10 px-6 py-14">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-lg font-bold text-white">س</span>
          <div>
            <p className="text-lg font-bold leading-tight">{tr('appName')}</p>
            <p className="muted text-xs">{tr('tagline')}</p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          {status === 'loading' ? (
            <Spinner />
          ) : status === 'authenticated' ? (
            <Link className="btn btn-primary" href="/app">
              فتح التطبيق
            </Link>
          ) : (
            <>
              <Link className="btn btn-ghost" href="/login">
                {tr('signIn')}
              </Link>
              <Link className="btn btn-primary" href="/register">
                {tr('signUp')}
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="grid gap-6 md:grid-cols-2 md:items-center">
        <div className="space-y-5">
          <h1 className="text-4xl font-bold leading-tight md:text-5xl">
            تواصل بلا وسطاء،
            <br />
            على خادمك أنت.
          </h1>
          <p className="muted text-lg">{tr('heroSubtitle')}</p>
          <div className="flex flex-wrap gap-3">
            <Link className="btn btn-primary" href="/register">
              {tr('signUp')}
            </Link>
            <Link className="btn btn-ghost" href="/login">
              {tr('signIn')}
            </Link>
          </div>
          <p className="muted text-sm">{tr('e2eeNotice')}</p>
        </div>

        <ul className="grid gap-3">
          {[
            ['💬', 'مراسلة فورية', 'رسائل فورية عبر WebSocket، حالات تسليم وقراءة، مرفقات ومجموعات.'],
            ['📣', 'قنوات بث', 'قنوات عامة وخاصة بأدوار مشرفين وروابط دعوة ومنشورات مثبّتة.'],
            ['🌐', 'شبكة اجتماعية', 'منشورات، متابعة، إعجابات، تعليقات، إعادة نشر ووسوم — بموجز زمني موثوق.'],
            ['📞', 'مكالمات WebRTC', 'صوت وفيديو نظير-لنظير، مع TURN ذاتي الاستضافة وترحيل إشارات على خادمك.'],
            ['🛡️', 'أمان عملي', 'Argon2/scrypt، جلسات قابلة للإلغاء، تحديد معدل الطلبات، وسجل تدقيق كامل.'],
            ['🏠', 'استضافة ذاتية', 'Docker Compose: PostgreSQL وRedis وMinIO وcoturn — بلا تبعية إلزامية على سحابة.'],
          ].map(([icon, title, description]) => (
            <li key={title} className="card flex gap-3 p-4">
              <span aria-hidden className="text-2xl">
                {icon}
              </span>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="muted text-sm">{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="muted mt-auto text-xs">
        رخصة AGPL-3.0 — المصدر الكامل متاح للتدقيق والتعديل.
      </footer>
    </main>
  );
}
