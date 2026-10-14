/**
 * The metrics registry and the access decision in front of it.
 *
 * Two properties are worth protecting here beyond "it counts": the text format must be what a
 * Prometheus scraper can parse without surprises (cumulative buckets, escaped labels, declared
 * types), and monitoring must stay **off** until an operator turns it on — a metrics endpoint that
 * announces itself is an information leak, not a feature.
 */
import { describe, expect, it } from 'vitest';
import { MetricsRegistry, metricsAccess } from '../../src/lib/metrics.js';

describe('MetricsRegistry', () => {
  it('counts per label set and renders the text format', () => {
    const registry = new MetricsRegistry();
    registry.inc('sovereign_http_requests_total', { method: 'GET', route: '/health', status: '200' }, 'HTTP responses');
    registry.inc('sovereign_http_requests_total', { method: 'GET', route: '/health', status: '200' });
    registry.inc('sovereign_http_requests_total', { method: 'POST', route: '/files', status: '201' });

    const text = registry.render();
    expect(text).toContain('# TYPE sovereign_http_requests_total counter');
    expect(text).toContain('sovereign_http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(text).toContain('sovereign_http_requests_total{method="POST",route="/files",status="201"} 1');
    expect(registry.value('sovereign_http_requests_total', { method: 'GET', route: '/health', status: '200' })).toBe(2);
  });

  it('labels are sorted and escaped so the format stays parseable', () => {
    const registry = new MetricsRegistry();
    registry.inc('sovereign_test_total', { route: '/a"b\\c' });
    expect(registry.render()).toContain('sovereign_test_total{route="/a\\"b\\\\c"} 1');
  });

  it('histogram buckets are cumulative and carry sum and count', () => {
    const registry = new MetricsRegistry();
    const labels = { method: 'GET', route: '/health' };
    registry.observe('sovereign_http_request_duration_seconds', 0.002, labels, 'duration', [0.005, 0.1]);
    registry.observe('sovereign_http_request_duration_seconds', 0.05, labels, 'duration', [0.005, 0.1]);
    registry.observe('sovereign_http_request_duration_seconds', 3, labels, 'duration', [0.005, 0.1]);

    const text = registry.render();
    expect(text).toContain('# TYPE sovereign_http_request_duration_seconds histogram');
    expect(text).toContain('sovereign_http_request_duration_seconds_bucket{method="GET",route="/health",le="0.005"} 1');
    expect(text).toContain('sovereign_http_request_duration_seconds_bucket{method="GET",route="/health",le="0.1"} 2');
    // The 3-second observation is only inside the implicit +Inf bucket.
    expect(text).toContain('sovereign_http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 3');
    expect(text).toContain('sovereign_http_request_duration_seconds_count{method="GET",route="/health"} 3');
    expect(text).toContain('sovereign_http_request_duration_seconds_sum{method="GET",route="/health"} 3.052');
  });

  it('gauges are read at scrape time, not accumulated', () => {
    const registry = new MetricsRegistry();
    const first = registry.render([{ name: 'process_uptime_seconds', help: 'uptime', value: 12 }]);
    const second = registry.render([{ name: 'process_uptime_seconds', help: 'uptime', value: 27 }]);
    expect(first).toContain('# TYPE process_uptime_seconds gauge');
    expect(first).toContain('process_uptime_seconds 12');
    expect(second).toContain('process_uptime_seconds 27');
  });

  it('reset clears series (so a test can start from zero)', () => {
    const registry = new MetricsRegistry();
    registry.inc('sovereign_test_total');
    registry.reset();
    expect(registry.render()).toBe('\n');
  });
});

describe('metricsAccess', () => {
  it('is disabled when no token is configured — the default', () => {
    expect(metricsAccess(undefined, null)).toBe('disabled');
    expect(metricsAccess(undefined, 'anything')).toBe('disabled');
  });

  it('allows the configured token and refuses everything else', () => {
    const token = 'metrics-token-with-enough-length';
    expect(metricsAccess(token, token)).toBe('allowed');
    expect(metricsAccess(token, null)).toBe('denied');
    expect(metricsAccess(token, '')).toBe('denied');
    expect(metricsAccess(token, `${token}x`)).toBe('denied');
    expect(metricsAccess(token, token.slice(0, -1))).toBe('denied');
    // A token of a different length must not be accepted by accident.
    expect(metricsAccess(token, token.slice(0, 8))).toBe('denied');
  });
});
