'use client';

import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { useMediaUrl } from '@/lib/media';

/** Shared, accessible primitives used across the whole client. */

export function Avatar({
  name,
  src,
  size = 40,
  online,
}: {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
  // Avatars are stored as /api/files/:id, i.e. they need the media token too.
  const resolvedSrc = useMediaUrl(src);
  return (
    <span className="relative inline-flex shrink-0">
      {resolvedSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolvedSrc}
          alt=""
          width={size}
          height={size}
          className="rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          aria-hidden
          className="grid place-items-center rounded-full bg-brand-500/15 font-semibold text-brand-600 dark:text-brand-300"
          style={{ width: size, height: size, fontSize: size * 0.4 }}
        >
          {initials || '؟'}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-label={online ? 'online' : 'offline'}
          className="absolute bottom-0 end-0 block rounded-full border-2"
          style={{
            width: size * 0.3,
            height: size * 0.3,
            background: online ? 'var(--success)' : 'var(--text-muted)',
            borderColor: 'var(--surface-raised)',
          }}
        />
      )}
    </span>
  );
}

export function Button({
  variant = 'primary',
  loading,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; loading?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${rest.className ?? ''}`} disabled={rest.disabled || loading}>
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
  const id = rest.id ?? rest.name;
  return (
    <label className="block space-y-1.5" htmlFor={id}>
      <span className="text-sm font-medium">{label}</span>
      <input {...rest} id={id} className={`input ${rest.className ?? ''}`} aria-invalid={Boolean(error)} />
      {hint && !error && <span className="muted block text-xs">{hint}</span>}
      {error && (
        <span className="block text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </label>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="loading"
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size, opacity: 0.7 }}
    />
  );
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-2 p-10 text-center">
      {icon && <div className="text-3xl opacity-60">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {description && <p className="muted max-w-sm text-sm">{description}</p>}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="card w-full max-w-lg space-y-4 p-5 shadow-xl">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close">
            ✕
          </Button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'brand' }) {
  const colors: Record<string, string> = {
    neutral: 'var(--surface-sunken)',
    success: 'color-mix(in oklab, var(--success) 18%, transparent)',
    danger: 'color-mix(in oklab, var(--danger) 18%, transparent)',
    brand: 'color-mix(in oklab, var(--accent) 18%, transparent)',
  };
  return <span className="pill" style={{ background: colors[tone] }}>{children}</span>;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ id: T; label: string }>;
}) {
  return (
    <div role="tablist" className="flex gap-1 rounded-xl p-1" style={{ background: 'var(--surface-sunken)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className="flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition"
          style={value === tab.id ? { background: 'var(--surface-raised)', boxShadow: '0 1px 2px rgb(0 0 0 / 0.08)' } : { color: 'var(--text-muted)' }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function formatTime(iso: string, locale = 'ar'): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(locale === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return locale === 'ar' ? 'أمس' : 'Yesterday';
  return date.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' });
}

export function useAutoScroll<T>(dependency: unknown) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (node) node.scrollTop = node.scrollHeight;
  }, [dependency]);
  return ref;
}
