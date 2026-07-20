import { describe, expect, it, vi } from "vitest";
import { listenOnAvailablePort } from "../src/lib/listen.js";

function portBusy(): NodeJS.ErrnoException {
  return Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
}

describe("listenOnAvailablePort", () => {
  it("uses the requested port when it is available", async () => {
    const listen = vi.fn().mockResolvedValue(undefined);

    await expect(
      listenOnAvailablePort(3000, { autoFallback: true, listen }),
    ).resolves.toBe(3000);
    expect(listen).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledWith(3000);
  });

  it("tries consecutive ports in development when a port is occupied", async () => {
    const listen = vi
      .fn()
      .mockRejectedValueOnce(portBusy())
      .mockRejectedValueOnce(portBusy())
      .mockResolvedValue(undefined);
    const onPortBusy = vi.fn();

    await expect(
      listenOnAvailablePort(3000, { autoFallback: true, listen, onPortBusy }),
    ).resolves.toBe(3002);
    expect(listen.mock.calls).toEqual([[3000], [3001], [3002]]);
    expect(onPortBusy.mock.calls).toEqual([
      [3000, 3001],
      [3001, 3002],
    ]);
  });

  it("does not change ports when fallback is disabled", async () => {
    const error = portBusy();
    const listen = vi.fn().mockRejectedValue(error);

    await expect(
      listenOnAvailablePort(3000, { autoFallback: false, listen }),
    ).rejects.toBe(error);
    expect(listen).toHaveBeenCalledOnce();
  });

  it("never hides errors other than an occupied port", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const listen = vi.fn().mockRejectedValue(error);

    await expect(
      listenOnAvailablePort(3000, { autoFallback: true, listen }),
    ).rejects.toBe(error);
    expect(listen).toHaveBeenCalledOnce();
  });
});
