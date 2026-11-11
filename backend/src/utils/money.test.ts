import { describe, expect, it } from 'vitest';
import { formatCentsToAmount, parseAmountToCents } from '../utils/money.js';

describe('money utilities', () => {
  it('parses valid positive numbers and decimal strings into cents without float drift', () => {
    expect(parseAmountToCents(10)).toBe(1000);
    expect(parseAmountToCents(0.1)).toBe(10);
    expect(parseAmountToCents('10.5')).toBe(1050);
    expect(parseAmountToCents(' 125.75 ')).toBe(12575);
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('19.99')).toBe(1999);
  });

  it('rejects zero, negative, malformed, or over-precise amounts', () => {
    expect(parseAmountToCents(0)).toBeNull();
    expect(parseAmountToCents('0')).toBeNull();
    expect(parseAmountToCents('0.00')).toBeNull();
    expect(parseAmountToCents(-10)).toBeNull();
    expect(parseAmountToCents('-10.00')).toBeNull();
    expect(parseAmountToCents('10.123')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents(Number.NaN)).toBeNull();
    expect(parseAmountToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('formats cents to 2-decimal string', () => {
    expect(formatCentsToAmount(100000)).toBe('1000.00');
    expect(formatCentsToAmount(5)).toBe('0.05');
    expect(formatCentsToAmount('12550')).toBe('125.50');
  });
});

