import type { ExecutionContext } from "../contracts.ts";

/** Backwards-compatible runtime extension while the public contract stays serializable. */
export type AbortableExecutionContext = ExecutionContext & { signal?: AbortSignal };

export function executionSignal(context: ExecutionContext): AbortSignal | undefined {
  return (context as AbortableExecutionContext).signal;
}
