import { describe, expect, it } from "vitest";
import { assertJsonCompatible, JsonCompatibilityError } from "./json-compat";

describe("assertJsonCompatible", () => {
  it("accepts JSON-safe values", () => {
    expect(() =>
      assertJsonCompatible({
        name: "agent",
        count: 3,
        ratio: 0.5,
        enabled: true,
        nothing: null,
        tags: ["a", "b"],
        nested: { list: [{ x: 1 }] },
      }),
    ).not.toThrow();
    expect(() => assertJsonCompatible(null)).not.toThrow();
    expect(() => assertJsonCompatible("text")).not.toThrow();
    expect(() => assertJsonCompatible(42)).not.toThrow();
    expect(() => assertJsonCompatible(true)).not.toThrow();
    expect(() => assertJsonCompatible([])).not.toThrow();
  });

  it("rejects undefined values", () => {
    expect(() => assertJsonCompatible(undefined)).toThrow(JsonCompatibilityError);
    expect(() => assertJsonCompatible({ a: undefined })).toThrow(/a.*undefined/);
    expect(() => assertJsonCompatible([undefined])).toThrow(/undefined/);
  });

  it("rejects BigInt, functions and symbols", () => {
    expect(() => assertJsonCompatible({ a: 10n })).toThrow(JsonCompatibilityError);
    expect(() => assertJsonCompatible({ a: () => 1 })).toThrow(/function/);
    expect(() => assertJsonCompatible({ a: Symbol("x") })).toThrow(/symbol/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => assertJsonCompatible({ a: NaN })).toThrow(/NaN/);
    expect(() => assertJsonCompatible({ a: Infinity })).toThrow(/Infinity/);
    expect(() => assertJsonCompatible({ a: -Infinity })).toThrow(/Infinity/);
  });

  it("rejects cyclic structures", () => {
    const self: Record<string, unknown> = {};
    self.self = self;
    expect(() => assertJsonCompatible(self)).toThrow(/cyclic/);

    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.next = b;
    b.prev = a;
    expect(() => assertJsonCompatible(a)).toThrow(/cyclic/);
  });

  it("rejects non-plain objects that JSON.stringify would serialize lossily", () => {
    expect(() => assertJsonCompatible(new Date())).toThrow(/non-plain/);
    expect(() => assertJsonCompatible(new Map([["a", 1]]))).toThrow(/non-plain/);
    expect(() => assertJsonCompatible(new Set([1]))).toThrow(/non-plain/);

    class Custom {
      value = 1;
    }
    expect(() => assertJsonCompatible(new Custom())).toThrow(/non-plain/);

    // toJSON-based coercion is not trusted: the function itself is rejected.
    expect(() => assertJsonCompatible({ toJSON: () => ({}) })).toThrow(/function/);
  });

  it("rejects sparse arrays (holes cannot round-trip through JSON)", () => {
    const sparse: string[] = [];
    sparse[2] = "value";
    expect(sparse.length).toBe(3);
    // JSON.stringify would silently turn the holes into null, so the explicit
    // rejection is required to keep persisted state lossless.
    expect(() => assertJsonCompatible(sparse)).toThrow(JsonCompatibilityError);
    expect(() => assertJsonCompatible({ list: sparse })).toThrow(/\$\.list\[0\]/);
  });

  it("reports the path of the offending value", () => {
    expect(() => assertJsonCompatible({ a: { b: [1, undefined] } })).toThrow(/\$\.a\.b\[1\]/);
  });
});
