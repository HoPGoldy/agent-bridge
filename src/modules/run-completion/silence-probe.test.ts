import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSilenceProbe } from "./silence-probe";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSilenceProbe", () => {
  it("does not fire before the threshold and fires with the silent ms afterwards", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 10 * 60_000, onProbe });
    probe.poke();

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(onProbe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onProbe).toHaveBeenCalledTimes(1);
    expect(onProbe).toHaveBeenCalledWith(10 * 60_000);
    probe.stop();
  });

  it("a poke before the threshold resets the countdown", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 1000, onProbe });

    probe.poke();
    vi.advanceTimersByTime(900);
    probe.poke(); // reset: silence window starts over
    vi.advanceTimersByTime(900);
    expect(onProbe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(onProbe).toHaveBeenCalledTimes(1);
    probe.stop();
  });

  it("pokes repeatedly keep the probe silent indefinitely", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 5000, onProbe });

    for (let i = 0; i < 20; i++) {
      probe.poke();
      vi.advanceTimersByTime(4999);
    }
    expect(onProbe).not.toHaveBeenCalled();
    probe.stop();
  });

  it("fires exactly once per silence window (no re-arm until poked)", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 1000, onProbe });
    probe.poke();

    vi.advanceTimersByTime(10_000);
    expect(onProbe).toHaveBeenCalledTimes(1);

    // After firing, the probe stays idle until the controller pokes again
    // (probe Q&A / any run event pokes it).
    vi.advanceTimersByTime(10_000);
    expect(onProbe).toHaveBeenCalledTimes(1);

    probe.poke();
    vi.advanceTimersByTime(1000);
    expect(onProbe).toHaveBeenCalledTimes(2);
    probe.stop();
  });

  it("stop cancels a pending fire and is idempotent", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 1000, onProbe });
    probe.poke();
    probe.stop();

    vi.advanceTimersByTime(100_000);
    expect(onProbe).not.toHaveBeenCalled();

    expect(() => probe.stop()).not.toThrow();
  });

  it("a poke after stop re-arms the probe", () => {
    const onProbe = vi.fn();
    const probe = createSilenceProbe({ silentMs: 1000, onProbe });
    probe.poke();
    probe.stop();

    probe.poke();
    vi.advanceTimersByTime(1000);
    expect(onProbe).toHaveBeenCalledTimes(1);
    probe.stop();
  });
});
