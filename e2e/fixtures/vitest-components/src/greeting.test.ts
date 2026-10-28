import { test, expect } from 'vitest';
import { mount } from 'svelte';
import Greeting from './Greeting.svelte';

test('greets loudly', () => {
  const el = document.createElement('div');
  mount(Greeting, { target: el, props: { name: 'ann' } });
  expect(el.textContent).toBe('Hello ANN');
});
