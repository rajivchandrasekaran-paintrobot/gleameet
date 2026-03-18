/** Simple Prometheus-style counters for observability */

const counters = new Map<string, number>();
const histogramBuckets = new Map<string, number[]>();

export function incrementCounter(name: string, labels: Record<string, string> = {}): void {
  const key = formatKey(name, labels);
  counters.set(key, (counters.get(key) || 0) + 1);
}

export function observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
  const key = formatKey(name, labels);
  const existing = histogramBuckets.get(key) || [];
  existing.push(value);
  histogramBuckets.set(key, existing);
}

export function getCounterValue(name: string, labels: Record<string, string> = {}): number {
  return counters.get(formatKey(name, labels)) || 0;
}

function formatKey(name: string, labels: Record<string, string>): string {
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return labelStr ? `${name}{${labelStr}}` : name;
}

/** Export all metrics in Prometheus text format */
export function exportMetrics(): string {
  const lines: string[] = [];

  // Counters
  for (const [key, value] of counters) {
    lines.push(`# TYPE ${key.split('{')[0]} counter`);
    lines.push(`${key} ${value}`);
  }

  // Histograms (summary stats)
  for (const [key, values] of histogramBuckets) {
    const baseName = key.split('{')[0];
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const count = values.length;

    lines.push(`# TYPE ${baseName} summary`);
    lines.push(`${key.replace(baseName, baseName + '_count')} ${count}`);
    lines.push(`${key.replace(baseName, baseName + '_sum')} ${sum.toFixed(2)}`);

    if (count > 0) {
      const p50 = sorted[Math.floor(count * 0.5)] || 0;
      const p95 = sorted[Math.floor(count * 0.95)] || 0;
      const p99 = sorted[Math.floor(count * 0.99)] || 0;
      const labelPart = key.includes('{') ? key.slice(key.indexOf('{')) : '';
      lines.push(`${baseName}{quantile="0.5"${labelPart ? ',' + labelPart.slice(1, -1) : ''}} ${p50.toFixed(2)}`);
      lines.push(`${baseName}{quantile="0.95"${labelPart ? ',' + labelPart.slice(1, -1) : ''}} ${p95.toFixed(2)}`);
      lines.push(`${baseName}{quantile="0.99"${labelPart ? ',' + labelPart.slice(1, -1) : ''}} ${p99.toFixed(2)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Reset all metrics (for testing) */
export function resetMetrics(): void {
  counters.clear();
  histogramBuckets.clear();
}
