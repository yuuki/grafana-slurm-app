export function formatDuration(seconds: number): string {
  const total = Math.max(0, seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) {
    return `${d}d ${h}h ${m}m`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

export function formatTimestamp(ts: number): string {
  if (ts === 0) {
    return '-';
  }
  return new Date(ts * 1000).toLocaleString();
}
