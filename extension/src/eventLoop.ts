/** Yield one event-loop turn so sync work does not burst on the main thread. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
