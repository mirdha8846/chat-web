export function log(event: string): void {
  const t = new Date().toISOString().slice(0, 19) + 'Z';
  process.stdout.write(JSON.stringify({ t, e: event }) + '\n');
}
export function shortHash(h: string): string {
  return h.slice(0, 6);
}
