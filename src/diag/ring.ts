/** Fixed-capacity ring buffer: keeps the newest `capacity` items, oldest first in toArray(). */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error('RingBuffer capacity must be >= 1');
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  push(item: T): void {
    const end = (this.start + this.len) % this.capacity;
    this.buf[end] = item;
    if (this.len < this.capacity) this.len++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Newest item, if any. */
  last(): T | undefined {
    return this.len ? this.buf[(this.start + this.len - 1) % this.capacity] : undefined;
  }

  toArray(): T[] {
    const out: T[] = new Array(this.len);
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(this.start + i) % this.capacity] as T;
    return out;
  }

  /** Replace the contents (keeps only the newest `capacity` items). */
  load(items: readonly T[]): void {
    this.clear();
    for (const it of items.slice(-this.capacity)) this.push(it);
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.start = 0;
    this.len = 0;
  }
}
