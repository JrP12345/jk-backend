/** Only Google's shared map embed URLs are permitted as public iframe sources. */
export function isGoogleMapsEmbedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 12000) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === "https:" && url.hostname === "www.google.com" && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === "/maps/embed" && Boolean(url.searchParams.get("pb"))
      && [...url.searchParams.keys()].every(key => key === "pb" || key === "hl");
  } catch { return false; }
}
