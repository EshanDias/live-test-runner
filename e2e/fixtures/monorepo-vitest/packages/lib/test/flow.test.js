import { test, expect } from 'vitest';
import { double, half } from '../src/math.js';

test('round trip', () => { expect(half(double(21))).toBe(21); });
test('fails on purpose', () => { expect(double(1)).toBe(3); });
