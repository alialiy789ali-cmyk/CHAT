/**
 * The crash reporter — the difference between "the app closed" and "here is why".
 *
 * The first released APK closed itself on a real phone, and the only report was the system's
 * generic dialog: no message, no stack, nothing to fix. Everything here exists so the *next* crash of
 * that kind leaves evidence: the error itself, its stack, a marker in the device log under a stable
 * tag, and a listener the UI can bind to.
 *
 * These tests deliberately feed the reporter the awkward inputs a real crash produces — a thrown
 * string, a plain object, a circular object, a listener that throws — because a reporter that fails
 * while reporting turns one silent crash into two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFatal,
  installGlobalHandler,
  lastFatal,
  onFatal,
  reportFatal,
} from '../src/lib/crash-report';

interface ErrorUtilsLike {
  getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

function withErrorUtils(runtime: ErrorUtilsLike, body: () => void): void {
  const globals = globalThis as { ErrorUtils?: ErrorUtilsLike };
  const previous = globals.ErrorUtils;
  globals.ErrorUtils = runtime;
  try {
    body();
  } finally {
    if (previous === undefined) delete globals.ErrorUtils;
    else globals.ErrorUtils = previous;
  }
}

describe('crash reporting', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearFatal();
    vi.restoreAllMocks();
    // The reporter writes to the device log on purpose; the test run does not need the noise.
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps the message and the stack of a real Error', () => {
    const report = reportFatal(new Error('cannot resolve crypto runtime'));
    expect(report.message).toBe('cannot resolve crypto runtime');
    expect(report.stack).toContain('cannot resolve crypto runtime');
    expect(report.fromReact).toBe(false);
    expect(report.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lastFatal()).toBe(report);
  });

  it('logs under one stable tag so `adb logcat -s SovereignCrash` works', () => {
    reportFatal(new Error('native module missing'), true);
    const line = (logged.mock.calls as unknown[][]).map((call) => call.join(' ')).join('\n');
    expect(line).toContain('[SovereignCrash]');
    expect(line).toContain('react error');
    expect(line).toContain('native module missing');
  });

  it('survives whatever was actually thrown, not just Error instances', () => {
    expect(reportFatal('plain string').message).toBe('plain string');
    expect(reportFatal({ code: 7 }).message).toContain('"code"');

    // A circular object used to be able to take the reporter down with it.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => reportFatal(circular)).not.toThrow();
    expect(reportFatal(circular).message).toBeTruthy();

    expect(reportFatal(undefined).message).toBe('undefined');
  });

  it('notifies subscribers, survives a broken one, and stops after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = onFatal((report) => seen.push(report.message));
    const broken = onFatal(() => {
      throw new Error('listener is broken');
    });

    expect(() => reportFatal(new Error('first'))).not.toThrow();
    expect(seen).toEqual(['first']);

    unsubscribe();
    broken();
    reportFatal(new Error('second'));
    expect(seen).toEqual(['first']);
  });

  it('clears the record so a handled error is not shown forever', () => {
    reportFatal(new Error('transient'));
    clearFatal();
    expect(lastFatal()).toBeNull();
  });

  it('records fatal errors from the platform handler and still calls the previous one', () => {
    const previous = vi.fn();
    const setGlobalHandler = vi.fn();
    withErrorUtils({ getGlobalHandler: () => previous, setGlobalHandler }, () => {
      installGlobalHandler();
      expect(setGlobalHandler).toHaveBeenCalledTimes(1);
      const handler = setGlobalHandler.mock.calls[0][0] as (error: unknown, isFatal?: boolean) => void;

      handler(new Error('boom'), true);
      expect(lastFatal()?.message).toBe('boom');
      expect(previous).toHaveBeenCalledWith(expect.any(Error), true);

      // A non-fatal error is the platform's business (it logs it); it must not take over the screen.
      clearFatal();
      handler(new Error('recoverable'), false);
      expect(lastFatal()).toBeNull();
      expect(previous).toHaveBeenCalledTimes(2);
    });
  });

  it('does nothing when the runtime has no ErrorUtils at all', () => {
    withErrorUtils({}, () => {
      expect(() => installGlobalHandler()).not.toThrow();
    });
  });
});
