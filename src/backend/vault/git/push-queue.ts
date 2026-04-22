import { logger } from "../../../utils/logger.js";

export interface PushQueueConfig {
  /**
   * Performs the actual push. Injected so unit tests can use a fake
   * and the real backend wires a simple-git wrapper in Task 11.
   * Throwing any error keeps the queue in pending state; retry
   * scheduling is handled by the backoff logic (Task 5).
   */
  push: () => Promise<void>;
  debounceMs: number;
  backoffMs: readonly number[];
}

type State =
  | { kind: "idle" }
  | { kind: "scheduled"; timer: NodeJS.Timeout }
  | { kind: "in-flight"; follow: boolean }
  | { kind: "backoff"; timer: NodeJS.Timeout; attempt: number };

/**
 * Debounced, single-flight push queue. `request()` bumps a debounce
 * timer; when it fires, one push runs. Concurrent requests during an
 * in-flight push queue exactly one follow-up on completion.
 */
export class PushQueue {
  private state: State = { kind: "idle" };
  private closing = false;
  private inFlightPromise: Promise<void> | null = null;
  private attempt = 0;

  constructor(private readonly cfg: PushQueueConfig) {}

  request(): void {
    if (this.closing) return;
    switch (this.state.kind) {
      case "idle":
        this.#schedule();
        return;
      case "scheduled":
        clearTimeout(this.state.timer);
        this.#schedule();
        return;
      case "in-flight":
        this.state = { kind: "in-flight", follow: true };
        return;
      case "backoff":
        // Do not shorten backoff — just mark that we still need to push.
        // The backoff timer already owns the next attempt.
        return;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.state.kind === "scheduled") {
      clearTimeout(this.state.timer);
      this.state = { kind: "idle" };
    }
    if (this.state.kind === "backoff") {
      clearTimeout(this.state.timer);
      this.state = { kind: "idle" };
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
  }

  #schedule(): void {
    const timer = setTimeout(() => {
      void this.#runPush();
    }, this.cfg.debounceMs);
    this.state = { kind: "scheduled", timer };
  }

  async #runPush(): Promise<void> {
    this.state = { kind: "in-flight", follow: false };
    const promise = this.cfg
      .push()
      .then(
        () => {
          // Success path: drain follow-up if queued.
          const follow = this.state.kind === "in-flight" && this.state.follow;
          this.state = { kind: "idle" };
          this.attempt = 0;
          if (follow && !this.closing) {
            this.#schedule();
          }
        },
        (err: unknown) => {
          // Backoff path: schedule a retry after the appropriate delay.
          logger.warn(
            `vault push failed (attempt ${this.attempt + 1}): ${err instanceof Error ? err.message : String(err)}`,
          );
          if (this.closing) {
            this.state = { kind: "idle" };
            return;
          }
          const ms = this.#backoffMs();
          this.attempt += 1;
          const timer = setTimeout(() => {
            void this.#runPush();
          }, ms);
          this.state = { kind: "backoff", timer, attempt: this.attempt };
        },
      )
      .finally(() => {
        this.inFlightPromise = null;
      });
    this.inFlightPromise = promise;
    await promise;
  }

  #backoffMs(): number {
    if (this.cfg.backoffMs.length === 0) return 0;
    const idx = Math.min(this.attempt, this.cfg.backoffMs.length - 1);
    return this.cfg.backoffMs[idx];
  }
}
