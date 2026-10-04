/** Analytics stores route shapes and referring origins, never private URLs. */
export function analyticsPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
  return value.split(/[?#]/, 1)[0].replace(/\/(?:[a-f\d]{24}|[a-f\d-]{36}|[A-Za-z\d_-]{32,})(?=\/|$)/gi, '/:id').slice(0, 200);
}

export function referrerOrigin(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.origin.slice(0, 300) : '';
  } catch { return ''; }
}
