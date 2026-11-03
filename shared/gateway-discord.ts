/** Discord IDs are unsigned 64-bit strings, never JavaScript numbers. */
export function discordId(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
