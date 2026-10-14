/**
 * Crash reporting for a phone nobody can attach a debugger to.
 *
 * A production APK on someone's real device is the worst place to learn that JavaScript threw an
 * error: the process is gone, the screen shows the home launcher, and the only witness is logcat on a
 * device that may be a thousand kilometres away. That is exactly what happened with this app's first
 * release build, and the report was a screenshot of the system's "app closed" dialog.
 *
 * So two things are kept here:
 *
 *  - **the last fatal error is stored**, with its stack, so a React error boundary can render it
 *    instead of a white screen — the user sees what happened and can retry;
 *  - **it is written to the device log** under one stable tag (`SovereignCrash`), so anyone can pull it
 *    with `adb logcat -s SovereignCrash` without rebuilding the app or knowing its internals.
 *
 * No error text is ever sent to the server: it can contain message text or key material, and a crash
 * reporter that uploads is a privacy decision this project has not made.
 */
export interface FatalReport {
  message: string;
  stack: string | null;
  /** `true` when React caught it (render/effect), `false` when the global handler did. */
  fromReact: boolean;
  at: string;
}

let last: FatalReport | null = null;
const listeners = new Set<(report: FatalReport) => void>();

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? null };
  if (typeof error === 'string') return { message: error, stack: null };
  try {
    return { message: JSON.stringify(error).slice(0, 500), stack: null };
  } catch {
    return { message: String(error), stack: null };
  }
}

/** Records a fatal error, logs it for `adb logcat`, and wakes any boundary that is listening. */
export function reportFatal(error: unknown, fromReact = false): FatalReport {
  const { message, stack } = describe(error);
  const report: FatalReport = { message, stack, fromReact, at: new Date().toISOString() };
  last = report;
  // One stable tag matters more than detail here: it is what a user can be asked to run.
  console.error(`[SovereignCrash] ${fromReact ? 'react' : 'global'} error: ${message}`, stack ?? '');
  for (const listener of listeners) {
    try {
      listener(report);
    } catch {
      // A failing listener must not replace the original error with its own.
    }
  }
  return report;
}

export function lastFatal(): FatalReport | null {
  return last;
}

/** Subscribes to fatal errors; returns the unsubscribe function (used by the UI boundary). */
export function onFatal(listener: (report: FatalReport) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearFatal(): void {
  last = null;
}

/**
 * Installs the process-wide handler.
 *
 * React Native routes uncaught JavaScript errors through `ErrorUtils`; keeping a reference to the
 * previous handler means the platform still does whatever it would have done (including its own
 * logging), while this app gets a copy it can show.
 */
export function installGlobalHandler(): void {
  const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void; setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void } }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    if (isFatal) reportFatal(error, false);
    previous?.(error, isFatal);
  });
}
