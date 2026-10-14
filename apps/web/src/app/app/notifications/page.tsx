'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar, Button, EmptyState, Spinner, formatTime } from '@/components/ui';
import { realtime } from '@/lib/realtime';
import { useT } from '@/lib/i18n';

interface Notification {
  id: string;
  kind: string;
  actor: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  conversationId: string | null;
  postId: string | null;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

const LABELS: Record<string, string> = {
  message: 'أرسل لك رسالة',
  follow: 'بدأ متابعتك',
  like: 'أعجبه منشورك',
  comment: 'علّق على منشورك',
  mention: 'أشار إليك',
  channel_post: 'نشر في قناة تتابعها',
  call: 'مكالمة واردة',
  moderation: 'قرار إشرافي',
  system: 'إشعار من النظام',
};

export default function NotificationsPage() {
  const tr = useT();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const result = await api.get<{ items: Notification[]; unread: number }>('/api/notifications?limit=50');
    setItems(result.items);
    setUnread(result.unread);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: a notification frame arrives over the socket while the page is open.
  useEffect(() => {
    const off = realtime.onFrame((frame) => {
      if (frame.t === 'notification') {
        setUnread((current) => current + 1);
        void load();
      }
    });
    return () => {
      off();
    };
  }, [load]);

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          {tr('notifications')} {unread > 0 && <span className="pill ms-2 bg-brand-500 text-white">{unread}</span>}
        </h1>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()}>
            تحديث
          </Button>
          {unread > 0 && (
            <Button
              variant="ghost"
              onClick={async () => {
                await api.post('/api/notifications/read', {});
                await load();
              }}
            >
              تعليم الكل كمقروء
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center p-8">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="لا إشعارات" description="ستظهر هنا التفاعلات والمكالمات والقرارات الإشرافية." icon="🔔" />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const preview = typeof item.payload?.preview === 'string' ? item.payload.preview : null;
            return (
              <li
                key={item.id}
                className="card flex items-center gap-3 p-3"
                style={item.readAt ? undefined : { borderInlineStartWidth: 3, borderInlineStartColor: 'var(--accent)' }}
              >
                {item.actor ? (
                  <Avatar name={item.actor.displayName} src={item.actor.avatarUrl} size={36} />
                ) : (
                  <span aria-hidden className="text-xl">
                    🔔
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {item.actor && <span className="font-semibold">{item.actor.displayName} </span>}
                    {LABELS[item.kind] ?? item.kind}
                  </p>
                  {item.conversationId && !preview && (
                    <a className="muted text-xs underline" href={`/app?c=${item.conversationId}`}>
                      افتح المحادثة
                    </a>
                  )}
                  {preview && <p className="muted truncate text-xs">{preview}</p>}
                </div>
                <span className="muted shrink-0 text-[11px]">{formatTime(item.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
