/** Names in a sentence: "a", "a and b", "a, b, and c". */
export function listing(xs: string[]): string {
  if (xs.length <= 2) return xs.join(' and ');
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}
