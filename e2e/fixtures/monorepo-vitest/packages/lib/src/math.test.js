import { test, expect } from 'vitest';
import { double, half } from './math.js';

test('doubles', () => { expect(double(2)).toBe(4); });
test('halves', () => { expect(half(4)).toBe(2); });
