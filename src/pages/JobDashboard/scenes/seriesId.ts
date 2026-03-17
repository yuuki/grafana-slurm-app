export function serializeLabelsMap(entries: Array<[string, string]>): string {
  return entries
    .filter(([key]) => key !== '__name__')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

export function buildSeriesIdFromLabels(metricName: string, labelEntries: Array<[string, string]>): string | null {
  if (!metricName) {
    return null;
  }

  const labels = serializeLabelsMap(labelEntries);
  return labels ? `${metricName}:${labels}` : metricName;
}
