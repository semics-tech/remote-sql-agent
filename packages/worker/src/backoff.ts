/**
 * Jittered exponential backoff for reconnects (§5.4).
 *
 * Jitter is not cosmetic here: 50+ workers all losing the control plane at once
 * (a restart, a network blip) would otherwise reconnect in lockstep and
 * repeatedly hammer it back down.
 */
export class Backoff {
  #attempt = 0;

  constructor(
    private readonly initialDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly jitterRatio: number,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const exponential = Math.min(this.initialDelayMs * 2 ** this.#attempt, this.maxDelayMs);
    this.#attempt += 1;
    const jitter = exponential * this.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(exponential + jitter));
  }

  reset(): void {
    this.#attempt = 0;
  }

  get attempt(): number {
    return this.#attempt;
  }
}
