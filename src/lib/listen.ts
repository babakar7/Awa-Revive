type ListenOptions = {
  autoFallback: boolean;
  maxFallbacks?: number;
  listen: (port: number) => Promise<unknown>;
  onPortBusy?: (port: number, nextPort: number) => void;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Bind the requested port, optionally trying the following ports when it is
 * already occupied. Production keeps autoFallback disabled so its configured
 * port remains a strict deployment contract.
 */
export async function listenOnAvailablePort(
  requestedPort: number,
  options: ListenOptions,
): Promise<number> {
  const maxFallbacks = options.autoFallback ? (options.maxFallbacks ?? 20) : 0;

  for (let offset = 0; offset <= maxFallbacks; offset += 1) {
    const port = requestedPort + offset;
    if (port > 65_535) break;

    try {
      await options.listen(port);
      return port;
    } catch (error) {
      const canRetry =
        options.autoFallback && errorCode(error) === "EADDRINUSE" && offset < maxFallbacks;
      if (!canRetry) throw error;
      options.onPortBusy?.(port, port + 1);
    }
  }

  throw new Error(
    `No available port found between ${requestedPort} and ${Math.min(65_535, requestedPort + maxFallbacks)}`,
  );
}
