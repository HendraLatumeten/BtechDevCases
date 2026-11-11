/**
 * Parse user-supplied monetary amounts strictly to positive integer cents.
 * Accepts numbers or strings like 10, "10", "10.5", "10.50".
 * Rejects <= 0, NaN, Infinity, negative numbers, or > 2 decimal places.
 */
export function parseAmountToCents(input: unknown): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    const normalized = input.toString();
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    return stringToCents(normalized);
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    return stringToCents(trimmed);
  }

  return null;
}

function stringToCents(value: string): number | null {
  const [whole, frac = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

export function formatCentsToAmount(cents: number | string | bigint): string {
  const num = typeof cents === 'bigint' ? Number(cents) : Number(cents);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

