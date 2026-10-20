import { render, screen, fireEvent } from '@testing-library/react';
import App, { describeInvoice } from './App';

test('greets the user', () => {
  render(<App user={{ name: 'Ada' }} />);
  expect(screen.getByText('Hello Ada')).toBeInTheDocument();
});

test('counts clicks', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Clicked 1')).toBeInTheDocument();
});

describe('describeInvoice', () => {
  it.each`
    source             | expected
    ${'SoftCo upload'} | ${'SoftCo'}
    ${'Manual'}        | ${'Other'}
  `('$source is $expected', ({ source, expected }) => {
    expect(describeInvoice({ SOURCE: source })).toBe(expected);
  });
});
