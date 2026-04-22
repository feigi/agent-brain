import { logger } from "../../../utils/logger.js";

export interface PushQueueConfig {
  // Throws → queue retains pending state and schedules backoff.
  push: () => Promise<void>;
  countUnpushed?: () => Promise<number>;
  debounceMs: number;
  // Backoff: fast first retry for transient blips, then exponential to a
  // long cap so we don't tight-loop against a broken remote.
  backoffMs: readonly number[];
}

type State =
  | { kind: "idle" }
  | { kind: "scheduled"; timer: NodeJS.Timeout }
  | { kind: "in-flight"; follow: boolean }
  | { kind: "backoff"; timer: NodeJS.Timeout; attempt: number };

export class PushQueue {
  private state: State = { kind: "idle" };
  private closing = false;
  private inFlightPromise: Promise<void> | null = null;
  private attempt = 0;
  private lastError: string | null = null;

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

  async unpushedCommits(): Promise<number> {
    if (!this.cfg.countUnpushed) return 0;
    try {
      return await this.cfg.countUnpushed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No upstream yet (pre-first-push) is expected — debug only.
      if (
        /no upstream|unknown revision @\{u\}|ambiguous argument '@\{u\}'/i.test(
          msg,
        )
      ) {
        logger.debug(`vault: unpushedCommits — no upstream yet: ${msg}`);
        return 0;
      }
      logger.warn(`vault: unpushedCommits failed, reporting 0: ${msg}`);
      return 0;
    }
  }

  lastPushError(): string | null {
    return this.lastError;
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
          const follow = this.state.kind === "in-flight" && this.state.follow;
          this.state = { kind: "idle" };
          this.attempt = 0;
          this.lastError = null;
          if (follow && !this.closing) {
            this.#schedule();
          }
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = msg;
          const attemptNum = this.attempt + 1;
          // Escalate to error once we've exhausted the backoff curve —
          // operators need a louder signal when retries keep failing.
          const exhausted = attemptNum >= this.cfg.backoffMs.length;
          if (exhausted) {
            logger.error(
              `vault push failed (attempt ${attemptNum}, exhausted backoff): ${msg}`,
            );
          } else {
            logger.warn(`vault push failed (attempt ${attemptNum}): ${msg}`);
          }
          if (this.closing) {
            this.attempt = 0;
            this.state = { kind: "idle" };
            return;
          }
          const ms = this.#backoffMs();
          this.attempt = attemptNum;
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
