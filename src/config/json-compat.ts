/**
 * Reusable JSON-compatibility validation.
 *
 * `JSON.stringify` silently drops `undefined`, functions and symbols, converts
 * `NaN`/`Infinity` to `null`, throws on cycles and `BigInt`, and can invoke
 * `toJSON` on exotic objects. Persisted state must never depend on those
 * implicit coercions, so payloads are validated before they reach the write
 * path. Only plain objects, arrays, strings, finite numbers, booleans and
 * `null` are accepted.
 */
export class JsonCompatibilityError extends Error {
  override readonly name = "JsonCompatibilityError";
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, path: string, ancestors: Set<object>): void {
  switch (typeof value) {
    case "undefined":
      throw new JsonCompatibilityError(`${path} is undefined; JSON cannot represent it`);
    case "bigint":
      throw new JsonCompatibilityError(`${path} is a BigInt; JSON cannot represent it`);
    case "function":
      throw new JsonCompatibilityError(`${path} is a function; JSON cannot represent it`);
    case "symbol":
      throw new JsonCompatibilityError(`${path} is a symbol; JSON cannot represent it`);
    case "number":
      if (!Number.isFinite(value)) {
        throw new JsonCompatibilityError(`${path} is ${String(value)}; JSON cannot represent it`);
      }
      return;
    case "boolean":
    case "string":
      return;
    case "object": {
      if (value === null) {
        return;
      }
      if (ancestors.has(value)) {
        throw new JsonCompatibilityError(`${path} is cyclic; JSON cannot represent it`);
      }
      if (Array.isArray(value)) {
        ancestors.add(value);
        try {
          for (let i = 0; i < value.length; i += 1) {
            walk(value[i], `${path}[${i}]`, ancestors);
          }
        } finally {
          ancestors.delete(value);
        }
        return;
      }
      if (!isPlainObject(value)) {
        const name =
          typeof (value as { constructor?: { name?: string } }).constructor?.name === "string"
            ? (value as { constructor: { name: string } }).constructor.name
            : "object";
        throw new JsonCompatibilityError(
          `${path} is a non-plain ${name}; JSON would serialize it lossily`,
        );
      }
      ancestors.add(value);
      try {
        for (const [key, entry] of Object.entries(value)) {
          walk(entry, `${path}.${key}`, ancestors);
        }
      } finally {
        ancestors.delete(value);
      }
      return;
    }
  }
}

/** Throws {@link JsonCompatibilityError} when `value` is not JSON-safe. */
export function assertJsonCompatible(value: unknown): void {
  walk(value, "$", new Set<object>());
}
