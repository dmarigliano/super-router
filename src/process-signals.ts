export type TerminationSignal = "SIGINT" | "SIGTERM";

export interface SignalEmitter {
  once(event: TerminationSignal, listener: () => void): unknown;
  off(event: TerminationSignal, listener: () => void): unknown;
}

export interface SignalBoundResult<T> {
  value: T;
  signal?: TerminationSignal;
}

/** Converts the first termination signal into cooperative cancellation. */
export async function withTerminationSignals<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  emitter: SignalEmitter = process,
): Promise<SignalBoundResult<T>> {
  const controller = new AbortController();
  let received: TerminationSignal | undefined;
  const onSignal = (signal: TerminationSignal): void => {
    if (received) return;
    received = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  const onInterrupt = (): void => onSignal("SIGINT");
  const onTerminate = (): void => onSignal("SIGTERM");
  emitter.once("SIGINT", onInterrupt);
  emitter.once("SIGTERM", onTerminate);
  try {
    const value = await operation(controller.signal);
    return { value, ...(received ? { signal: received } : {}) };
  } finally {
    emitter.off("SIGINT", onInterrupt);
    emitter.off("SIGTERM", onTerminate);
  }
}
