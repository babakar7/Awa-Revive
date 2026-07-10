/**
 * Per-key task serialization: messages from the same client are processed in
 * order, one at a time, even when webhooks arrive concurrently. Different
 * clients still run in parallel.
 */
const chains = new Map<string, Promise<void>>();

export function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task).catch(() => {});
  chains.set(key, next);
  // Cleanup once this chain settles and is still the tail.
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}
