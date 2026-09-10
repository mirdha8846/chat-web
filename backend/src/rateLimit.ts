export class Bucket {
  private hits: number[] = [];
  constructor(private max = 20, private winMs = 10_000) {}
  take(): boolean {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.winMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
