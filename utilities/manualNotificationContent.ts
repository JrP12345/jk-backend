/** Values from the manual organization-notification form are rendered in email
 * HTML and later passed to the dashboard router. Keep that boundary strict. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Manual notifications may only navigate within Ekavyu. Provider-generated
 * capability links use their own trusted paths and do not pass through here. */
export function normalizeManualNotificationActionUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048) return null;

  const candidate = value.trim();
  if (!candidate || candidate.startsWith("//") || candidate.includes("\\") || /[\r\n]/.test(candidate)) return null;

  try {
    const parsed = new URL(candidate, "https://ekavyu.invalid");
    if (parsed.origin !== "https://ekavyu.invalid") return null;
    if (!/^(?:\/dashboard|\/track)(?:\/|$)/.test(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
