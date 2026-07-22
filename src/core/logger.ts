export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createLogger(scope: string): Logger {
  const prefix = () => `[${timestamp()}] [${scope}]`;

  const log = (level: LogLevel, write: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      if (LEVEL_ORDER[level] < resolveMinLevel()) return;
      write(prefix(), ...args);
    };
  };

  return {
    debug: log("debug", console.debug),
    info: log("info", console.log),
    warn: log("warn", console.warn),
    error: log("error", console.error),
  };
}
