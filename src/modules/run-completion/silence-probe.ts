/**
 * Silence probe (decided in `docs/grill-context/qa-log.md`, 2026-08-19（二）,
 * layer 2): after N minutes without any run event, the controller sends a
 * probe message into the session instead of passively declaring the run dead.
 *
 * The timer is resettable: controllers call `poke()` on EVERY run event
 * (assistant messages, tool progress, probe Q&A, ...). When it fires,
 * `onProbe(silentMs)` runs with the silence threshold that elapsed.
 *
 * Deliberately minimal per the decision: no max-probe count, no
 * force-close — the wall-clock run timeout owned by the controllers (layer
 * 3) is the only backstop. A probe that goes unanswered just leaves the
 * timer idle.
 */

export interface SilenceProbeOptions {
  /** Silence threshold in ms; `onProbe` receives this value when it fires. */
  silentMs: number;
  /** Fired once each time the silence threshold elapses without a reset. */
  onProbe: (silentMs: number) => void;
}

/** Resettable silence timer. See {@link createSilenceProbe}. */
export interface SilenceProbe {
  /** Restarts the silence window; call on every run event. */
  poke(): void;
  /** Stops the timer and drops the pending fire. Idempotent. */
  stop(): void;
}

/** Creates a per-run silence probe. See module doc. */
export function createSilenceProbe(options: SilenceProbeOptions): SilenceProbe {
  const { silentMs, onProbe } = options;
  let timer: NodeJS.Timeout | null = null;

  function arm(): void {
    timer = setTimeout(() => {
      timer = null;
      onProbe(silentMs);
    }, silentMs);
    timer.unref?.();
  }

  return {
    poke(): void {
      if (timer !== null) {
        clearTimeout(timer);
      }
      arm();
    },
    stop(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
