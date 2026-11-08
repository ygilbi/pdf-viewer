import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring';

describe('RingBuffer', () => {
  it('keeps items in order until full', () => {
    const r = new RingBuffer<number>(3);
    expect(r.toArray()).toEqual([]);
    expect(r.last()).toBeUndefined();
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    expect(r.size).toBe(2);
    expect(r.last()).toBe(2);
  });

  it('drops the oldest items once full', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.toArray()).toEqual([5, 6, 7]);
    expect(r.size).toBe(3);
    expect(r.last()).toBe(7);
  });

  it('load() keeps only the newest capacity items; clear() empties', () => {
    const r = new RingBuffer<number>(300);
    r.load(Array.from({ length: 1000 }, (_, i) => i));
    expect(r.size).toBe(300);
    expect(r.toArray()[0]).toBe(700);
    expect(r.last()).toBe(999);
    r.clear();
    expect(r.toArray()).toEqual([]);
  });

  it('rejects a zero capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});
