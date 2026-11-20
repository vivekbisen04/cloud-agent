import { expect, test } from "bun:test";
import type { ChatResult } from "@openrouter/sdk/models";
import { isFreeModel, rateLimitedSend } from "./model-client";

const result = { choices: [] } as unknown as ChatResult;

test("identifies free model variants", () => {
  expect(isFreeModel("openrouter/free")).toBe(true);
  expect(isFreeModel("nvidia/example:free")).toBe(true);
  expect(isFreeModel("google/gemini-3-flash-preview")).toBe(false);
});

test("paces requests and retries a per-minute 429", async () => {
  let time = 0;
  const delays: number[] = [];
  let calls = 0;
  const send = rateLimitedSend(
    async () => {
      calls++;
      if (calls === 2) {
        const error = new Error(
          "Rate limit exceeded: free-models-per-min",
        ) as Error & { statusCode: number };
        error.statusCode = 429;
        throw error;
      }
      return result;
    },
    {
      minIntervalMs: 3_500,
      now: () => time,
      sleep: async (ms) => {
        delays.push(ms);
        time += ms;
      },
    },
  );
  await send({});
  await send({});
  expect(calls).toBe(3);
  expect(delays).toEqual([3_500, 65_000]);
});

test("does not retry the daily limit", async () => {
  let calls = 0;
  const send = rateLimitedSend(
    async () => {
      calls++;
      const error = new Error("free-models-per-day") as Error & {
        statusCode: number;
      };
      error.statusCode = 429;
      throw error;
    },
    { minIntervalMs: 3_500, sleep: async () => {} },
  );
  await expect(send({})).rejects.toThrow("daily request limit");
  expect(calls).toBe(1);
});

test("one pacer spaces concurrent requests from different workers", async () => {
  let time = 0;
  const pacer = new (await import("./model-client")).RequestPacer();
  const starts: number[] = [];
  const sleep = async (ms: number) => {
    time += ms;
  };
  const first = rateLimitedSend(
    async () => {
      starts.push(time);
      return result;
    },
    { minIntervalMs: 3_500, pacer, now: () => time, sleep },
  );
  const second = rateLimitedSend(
    async () => {
      starts.push(time);
      return result;
    },
    { minIntervalMs: 3_500, pacer, now: () => time, sleep },
  );
  await Promise.all([first({}), second({})]);
  expect(starts).toEqual([0, 3_500]);
});

test("a rate-limit cooldown pauses every worker sharing the pacer", async () => {
  let time = 0;
  const pacer = new (await import("./model-client")).RequestPacer();
  let attempts = 0;
  const starts: number[] = [];
  const sleep = async (ms: number) => {
    time += ms;
  };
  const first = rateLimitedSend(
    async () => {
      starts.push(time);
      if (attempts++ === 0) {
        const error = new Error("free-models-per-min") as Error & {
          statusCode: number;
        };
        error.statusCode = 429;
        throw error;
      }
      return result;
    },
    { minIntervalMs: 3_500, pacer, now: () => time, sleep },
  );
  const second = rateLimitedSend(
    async () => {
      starts.push(time);
      return result;
    },
    { minIntervalMs: 3_500, pacer, now: () => time, sleep },
  );
  await Promise.all([first({}), second({})]);
  expect(starts[0]).toBe(0);
  expect(starts.slice(1).every((start) => start >= 65_000)).toBe(true);
});
