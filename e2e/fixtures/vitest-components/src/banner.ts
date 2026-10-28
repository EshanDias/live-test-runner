import html from './banner.html?raw';

export function banner(): string {
  return html.trim();
}
