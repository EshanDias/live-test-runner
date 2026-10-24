import Greeting from './Greeting.svelte';

test('greets loudly', () => {
  const el = document.createElement('div');
  new Greeting({ target: el, props: { name: 'ann' } });
  expect(el.textContent).toBe('Hello ANN');
});
