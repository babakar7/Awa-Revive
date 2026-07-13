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

/**
 * Wait for all currently-queued tasks to finish, up to `timeoutMs`. Called on
 * graceful shutdown: the webhook ACKs 200 and processes the message in a
 * detached enqueue task that outlives the HTTP response, so without draining, a
 * deploy (SIGTERM) would kill in-flight conversations mid-turn — and because
 * the message id is already recorded, they'd never be re-delivered. Returns how
 * many client chains it waited on. New tasks aren't expected during shutdown
 * (the server has stopped accepting webhooks), so a snapshot is enough.
 */
export async function drainQueues(timeoutMs: number): Promise<number> {
  const pending = Array.from(chains.values());
  if (pending.length === 0) return 0;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return pending.length;
}
