import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type SignalEmitter, withTerminationSignals } from "../src/process-signals.ts";

describe("CLI termination propagation", () => {
  test("turns SIGINT into an AbortSignal and records the conventional signal", async () => {
    const emitter = new EventEmitter() as SignalEmitter & EventEmitter;
    const execution = withTerminationSignals(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        emitter.emit("SIGINT");
      });
      return signal.aborted;
    }, emitter);

    await expect(execution).resolves.toEqual({ value: true, signal: "SIGINT" });
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
});
