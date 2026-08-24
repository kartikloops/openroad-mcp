import { Mutex } from "async-mutex";

const DEFAULT_MAX_SIZE = 128 * 1024;

export class CircularBuffer {
  readonly maxSize: number;
  private readonly _chunks: string[] = [];
  private _totalSize = 0;
  private _discardedChars = 0;
  private readonly _mutex = new Mutex();
  private _dataAvailable = false;
  private _resolvers: Array<(available: boolean) => void> = [];

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this._totalSize;
  }

  get chunkCount(): number {
    return this._chunks.length;
  }

  /**
   * Characters dropped on overflow since the last takeDiscarded().
   *
   * Overflow silently deletes the oldest output, so a caller that does not
   * know this number cannot tell a complete result from a mutilated one.
   */
  get discardedChars(): number {
    return this._discardedChars;
  }

  async append(data: string): Promise<void> {
    if (!data) return;

    const release = await this._mutex.acquire();
    try {
      if (this.maxSize === 0) return;

      this._chunks.push(data);
      this._totalSize += data.length;

      while (this._totalSize > this.maxSize && this._chunks.length > 1) {
        const old = this._chunks.shift()!;
        this._totalSize -= old.length;
        this._discardedChars += old.length;
      }

      // A single chunk larger than maxSize is truncated to its last maxSize
      // bytes so capacity is never permanently exceeded.
      if (this._totalSize > this.maxSize) {
        const chunk = this._chunks[0]!;
        this._chunks[0] = chunk.slice(chunk.length - this.maxSize);
        this._discardedChars += chunk.length - this.maxSize;
        this._totalSize = this.maxSize;
      }

      this._dataAvailable = true;
      const pending = this._resolvers.splice(0);
      for (const resolve of pending) resolve(true);
    } finally {
      release();
    }
  }

  /**
   * Return the discard count and reset it, so the next command starts from
   * zero. Per-command accounting needs a reset point: a cumulative-only
   * counter would report a previous command's loss as this one's.
   */
  async takeDiscarded(): Promise<number> {
    const release = await this._mutex.acquire();
    try {
      const discarded = this._discardedChars;
      this._discardedChars = 0;
      return discarded;
    } finally {
      release();
    }
  }

  async drainAll(): Promise<string[]> {
    const release = await this._mutex.acquire();
    try {
      const result = this._chunks.splice(0);
      this._totalSize = 0;
      this._dataAvailable = false;
      return result;
    } finally {
      release();
    }
  }

  async peekAll(): Promise<string[]> {
    const release = await this._mutex.acquire();
    try {
      return [...this._chunks];
    } finally {
      release();
    }
  }

  async waitForData(timeoutMs: number): Promise<boolean> {
    if (this._dataAvailable) return true;

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this._resolvers.indexOf(wakeUp);
        if (idx !== -1) this._resolvers.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      const wakeUp = (available: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };

      // Re-check _dataAvailable under the mutex: runExclusive is async, so
      // append() can fire between the fast-path check above and the push
      // below, drain an empty _resolvers, and release, leaving wakeUp
      // unnoticed and the caller waiting the full timeout.
      this._mutex.runExclusive(() => {
        if (this._dataAvailable) {
          wakeUp(true);
        } else {
          this._resolvers.push(wakeUp);
        }
      }).catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async clear(): Promise<void> {
    const release = await this._mutex.acquire();
    try {
      this._chunks.splice(0);
      this._totalSize = 0;
      this._dataAvailable = false;
      const pending = this._resolvers.splice(0);
      for (const resolve of pending) resolve(false);
    } finally {
      release();
    }
  }

  toText(chunks: string[]): string {
    return chunks.join("");
  }

  async getStats(): Promise<{
    totalChars: number;
    chunkCount: number;
    maxSize: number;
    utilizationPercent: number;
    discardedChars: number;
  }> {
    const release = await this._mutex.acquire();
    try {
      return {
        totalChars: this._totalSize,
        chunkCount: this._chunks.length,
        maxSize: this.maxSize,
        utilizationPercent:
          this.maxSize > 0 ? Math.floor((this._totalSize / this.maxSize) * 100) : 0,
        discardedChars: this._discardedChars,
      };
    } finally {
      release();
    }
  }
}
