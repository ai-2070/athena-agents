import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js';

/** Local notation needs the country chosen in setup, never the computer's locale. */
export function normalizeWhatsAppPhone(value: string, country?: CountryCode): string | null {
  if (value.length > 100 || (!country && !value.trim().startsWith('+'))) return null;
  const phone = parsePhoneNumberFromString(value, { defaultCountry: country, extract: false });
  return phone?.isValid() && !phone.ext ? phone.number : null;
}

export function canonicalWhatsAppPhone(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(value) && normalizeWhatsAppPhone(value) === value;
}

/** Meta's phone identity is international digits, not a display name or a local number. */
export function whatsAppSenderPhone(value: string | undefined): string | null {
  if (!value || !/^[1-9]\d{1,14}$/.test(value)) return null;
  const phone = `+${value}`;
  return canonicalWhatsAppPhone(phone) ? phone : null;
}

/** Provider hashes may use hex or base64; receipts keep only canonical SHA-256 hex. */
export function whatsAppMediaHash(value: string): string | null {
  if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const bytes = atob(value);
  return bytes.length === 32 && btoa(bytes) === value
    ? Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    : null;
}
