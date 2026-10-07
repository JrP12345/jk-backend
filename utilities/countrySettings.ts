export const COUNTRY_SETTINGS = {
  IN: { currency: "INR", locale: "en-IN", defaultTimezone: "Asia/Kolkata" },
  US: { currency: "USD", locale: "en-US", defaultTimezone: null },
  CA: { currency: "CAD", locale: "en-CA", defaultTimezone: null },
  GB: { currency: "GBP", locale: "en-GB", defaultTimezone: "Europe/London" },
  AE: { currency: "AED", locale: "en-AE", defaultTimezone: "Asia/Dubai" },
} as const;

export type CountryCode = keyof typeof COUNTRY_SETTINGS;

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && Object.hasOwn(COUNTRY_SETTINGS, value);
}

export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateCountrySettings(countryCode: CountryCode, currency: string | undefined, timezone: string | undefined): string | null {
  const settings = COUNTRY_SETTINGS[countryCode];
  if (currency && currency !== settings.currency) return `${countryCode} organizations must use ${settings.currency}`;
  if (!isIanaTimezone(timezone || settings.defaultTimezone)) return "A valid timezone is required";
  return null;
}
