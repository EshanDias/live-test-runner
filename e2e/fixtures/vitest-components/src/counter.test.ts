import { test, expect } from 'vitest';
import { createApp, nextTick } from 'vue';
import Counter from './Counter.vue';

test('counter counts', async () => {
  const el = document.createElement('div');
  createApp(Counter, { name: 'clicks' }).mount(el);
  el.querySelector('button')!.click();
  await nextTick();
  expect(el.textContent).toContain('CLICKS: 1');
});

test('counter starts at zero', () => {
  const el = document.createElement('div');
  createApp(Counter, { name: 'n' }).mount(el);
  expect(el.textContent).toContain('N: 0');
});
