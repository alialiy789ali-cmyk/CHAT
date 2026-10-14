/**
 * A small Prometheus-compatible metrics registry.
 *
 * Written by hand instead of pulling in a client library, for two reasons that matter here:
 *
 *   - the exposure format is a documented plain-text protocol (Prometheus text format 0.0.4), so a
 *     few dozen lines cover it, while a library adds a dependency to a server that is supposed to be
 *     auditable and self-hosted;
 *   - cardinality is the one thing that actually breaks metrics in production, and it is easier to
 *     keep honest when the only labels available are the ones this file puts there. Requests are
 *     labelled by **route pattern**, never by URL: `/api/files/9f1c…` and `/api/files/2b7a…` are the
 *     same series, otherwise every attachment would create a new one.
 *
 * What is *not* here is as deliberate as what is: no user ids, no conversation ids, no message
 * contents. A metrics endpoint that leaks who talks to whom would undo the metadata minimisation the
 * rest of the platform is built around, and it is often scraped into a system with weaker access
 * control than the database.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export type MetricLabels = Record<string, string | number>;

/** Latency buckets in seconds: most API calls answer in the low milliseconds, uploads do not. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface CounterSeries {
  help: string;
  labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  help: string;
  labels: MetricLabels;
  buckets: number[];
  /** count per bucket, cumulative is computed at render time */
  counts: number[];
  sum: number;
  count: number;
}

/** Prometheus label values escape backslash, double quote and newline; nothing else is legal. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function seriesKey(name: string, labels: MetricLabels): string {
  const sorted = Object.keys(labels).sort();
  return `${name}{${sorted.map((key) => `${key}=${String(labels[key])}`).join(',')}}`;
}

/**
 * Renders a label set in a stable order.
 *
 * `le` (the histogram bucket bound) is placed last, which is the convention every Prometheus client
 * library follows: it keeps `_bucket` lines readable side by side, and a scraper accepts any order.
 */
function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels)
    .filter((key) => key !== 'le')
    .sort();
  if ('le' in labels) keys.push('le');
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabel(String(labels[key]))}"`).join(',')}}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  /** Adds to a counter. `help` is only read the first time a series is created. */
  inc(name: string, labels: MetricLabels = {}, help = '', by = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    this.counters.set(key, { help: help || name, labels, value: by });
  }

  /** Records one observation of a histogram (seconds). */
  observe(name: string, seconds: number, labels: MetricLabels = {}, help = '', buckets = DEFAULT_BUCKETS): void {
    const key = seriesKey(name, labels);
    let series = this.histograms.get(key);
    if (!series) {
      series = { help: help || name, labels, buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, series);
    }
    series.sum += seconds;
    series.count += 1;
    for (let index = 0; index < series.buckets.length; index += 1) {
      if (seconds <= series.buckets[index]!) {
        series.counts[index] += 1;
        return;
      }
    }
    // Larger than the last bucket: only the implicit `+Inf` bucket covers it.
  }

  /** Reads one counter value (used by tests and by alerting code paths). */
  value(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(seriesKey(name, labels))?.value ?? 0;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  /** Prometheus text format 0.0.4 (the format every scraper understands). */
  render(current: Array<{ name: string; help: string; value: number }> = []): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const typeOf = new Map<string, string>();
    for (const [key, series] of this.counters) typeOf.set(key.split('{')[0]!, 'counter');
    for (const [key, series] of this.histograms) typeOf.set(key.split('{')[0]!, 'histogram');

    for (const [key, series] of this.counters) {
      const family = key.split('{')[0]!;
      if (!emitted.has(family)) {
        lines.push(`# HELP ${family} ${series.help}`);
        lines.push(`# TYPE ${family} ${typeOf.get(family) ?? 'counter'}`);
        emitted.add(family);
      }
      lines.push(`${family}${renderLabels(series.labels)} ${series.value}`);
    }

    for (const [key, series] of this.histograms) {
      const family = key.split('{')[0]!;
      if (!emitted.has(family)) {
        lines.push(`# HELP ${family} ${series.help}`);
        lines.push(`# TYPE ${family} histogram`);
        emitted.add(family);
      }
      let cumulative = 0;
      for (let index = 0; index < series.buckets.length; index += 1) {
        cumulative += series.counts[index]!;
        lines.push(
          `${family}_bucket${renderLabels({ ...series.labels, le: String(series.buckets[index]) })} ${cumulative}`,
        );
      }
      lines.push(`${family}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
      lines.push(`${family}_sum${renderLabels(series.labels)} ${series.sum}`);
      lines.push(`${family}_count${renderLabels(series.labels)} ${series.count}`);
    }

    for (const gauge of current) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      lines.push(`${gauge.name} ${gauge.value}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

/** One registry per process: the API serves one deployment from one Node process family. */
export const metrics = new MetricsRegistry();

export type MetricsAccess = 'disabled' | 'allowed' | 'denied';

/**
 * Decides whether a scrape may proceed.
 *
 * The endpoint is **off unless a token is configured** (`METRICS_TOKEN`). That default is the
 * important half: a metrics route that answers by itself would expose traffic volume, route names
 * and error rates to anyone who can reach the API, and "someone will lock it down later" is how that
 * ends. With no token the route reports "not found", so an operator who never set one sees no trace
 * of a feature they did not enable.
 *
 * Comparison is constant-time over the SHA-256 digests of both values, which is what makes the token
 * safe to compare in a request handler (a plain `===` leaks the matching prefix through timing).
 */
export function metricsAccess(configured: string | undefined, provided: string | null): MetricsAccess {
  if (!configured) return 'disabled';
  if (!provided) return 'denied';
  const expected = createHash('sha256').update(configured, 'utf8').digest();
  const actual = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(expected, actual) ? 'allowed' : 'denied';
}
