/**
 * Convert a test full-name to a regex pattern suitable for --testNamePattern.
 * '…' and '<dynamic>' placeholders (from template-literal test discovery),
 * Jest's % placeholders (%s, %d, %p, …) and the $variable / $obj.prop
 * placeholders of it.each`table` are expanded to '.*' so they match the real
 * names Jest emits at runtime. Everything else is matched literally.
 */
export function nameToPattern(name: string): string {
  const escLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name
    .split(/…|<dynamic>|%[sdifjopP#%]|\$[A-Za-z_][\w]*(?:\.[\w]+)*/)
    .map(escLiteral)
    .join('.*');
}
