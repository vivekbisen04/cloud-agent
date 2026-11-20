import type { ChatResult } from "@openrouter/sdk/models";

export function isFreeModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}

export class RequestPacer {
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();

  cooldown(ms: number, now = Date.now): void {
    this.nextAt = Math.max(this.nextAt, now() + ms);
  }

  async run<Result>(
    work: () => Promise<Result>,
    intervalMs: number,
    now = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    onWait?: (ms: number) => void,
    onError?: (error: unknown) => void,
  ): Promise<Result> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const pause = Math.max(0, this.nextAt - now());
      if (pause) {
        onWait?.(pause);
        await sleep(pause);
      }
      this.nextAt = now() + intervalMs;
      return await work();
    } catch (error) {
      onError?.(error);
      throw error;
    } finally {
      release();
    }
  }
}

export type RateLimitOptions = {
  minIntervalMs: number;
  pacer?: RequestPacer;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function isRateLimit(error: unknown): error is Error & {
  statusCode: number;
  headers?: Headers;
  body?: string;
} {
  return (
    error instanceof Error && "statusCode" in error && error.statusCode === 429
  );
}

function retryDelay(error: { headers?: Headers }, fallbackMs: number): number {
  const value = error.headers?.get("retry-after");
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000) + 1000;
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(1000, date - Date.now() + 1000)
    : fallbackMs;
}

export function rateLimitedSend<Request, Result extends ChatResult>(
  send: (request: Request) => Promise<Result>,
  options: RateLimitOptions,
): (request: Request) => Promise<Result> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastRequestAt = -Infinity;

  return async (request: Request) => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        if (options.pacer) {
          return await options.pacer.run(
            () => send(request),
            options.minIntervalMs,
            now,
            sleep,
            (pause) =>
              options.log?.(
                `Waiting ${Math.ceil(pause / 1000)}s for model rate limit...`,
              ),
            (error) => {
              if (!isRateLimit(error)) return;
              if (
                /free-models-per-day|requests.per.day|daily/i.test(
                  `${error.message} ${error.body ?? ""}`,
                )
              )
                return;
              options.pacer?.cooldown(
                retryDelay(error, options.minIntervalMs > 0 ? 65_000 : 10_000),
                now,
              );
            },
          );
        }
        const pause = Math.max(
          0,
          lastRequestAt + options.minIntervalMs - now(),
        );
        if (pause > 0) {
          options.log?.(
            `Waiting ${Math.ceil(pause / 1000)}s for model rate limit...`,
          );
          await sleep(pause);
        }
        lastRequestAt = now();
        return await send(request);
      } catch (error) {
        if (!isRateLimit(error)) throw error;
        const detail = `${error.message} ${error.body ?? ""}`;
        if (/free-models-per-day|requests.per.day|daily/i.test(detail)) {
          throw new Error(
            "OpenRouter's free-model daily request limit has been reached. Try again after the quota resets or use a paid model.",
            { cause: error },
          );
        }
        if (attempt === 2) throw error;
        const delay = retryDelay(
          error,
          options.minIntervalMs > 0 ? 65_000 : 10_000,
        );
        options.log?.(
          `OpenRouter rate limit reached; retrying in ${Math.ceil(delay / 1000)}s...`,
        );
        if (!options.pacer) await sleep(delay);
      }
    }
    throw new Error("Model retry limit reached");
  };
}
