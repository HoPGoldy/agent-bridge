import { describe, expect, it } from "vitest";
import { imClientSessionStateCodec } from "./client-session-state";

describe("imClientSessionStateCodec", () => {
  it("decodes a full state document", () => {
    expect(
      imClientSessionStateCodec.decode(
        { version: 1, defaultWorkingDirectory: "/tmp/a" },
        1,
        { clientSessionId: "client-1" },
      ),
    ).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/a" });
  });

  it("decodes a minimal state document", () => {
    expect(imClientSessionStateCodec.decode({ version: 1 }, 1, { clientSessionId: "c" })).toEqual({
      version: 1,
    });
  });

  it("rejects non-object payloads and wrong versions", () => {
    expect(() => imClientSessionStateCodec.decode(null, 1, { clientSessionId: "c" })).toThrow(
      /expected a state document/,
    );
    expect(() =>
      imClientSessionStateCodec.decode({ version: 2 }, 2, { clientSessionId: "c" }),
    ).toThrow(/expected a versioned state document/);
    expect(() =>
      imClientSessionStateCodec.decode({ version: 1 }, 9, { clientSessionId: "c" }),
    ).toThrow(/unsupported IM client session state version 9/);
  });

  it("rejects a malformed defaultWorkingDirectory", () => {
    expect(() =>
      imClientSessionStateCodec.decode({ version: 1, defaultWorkingDirectory: "" }, 1, {
        clientSessionId: "c",
      }),
    ).toThrow(/defaultWorkingDirectory/);
    expect(() =>
      imClientSessionStateCodec.decode({ version: 1, defaultWorkingDirectory: 42 }, 1, {
        clientSessionId: "c",
      }),
    ).toThrow(/defaultWorkingDirectory/);
  });

  it("encodes the canonical plain shape", () => {
    expect(imClientSessionStateCodec.encode({ version: 1 })).toEqual({ version: 1 });
    expect(
      imClientSessionStateCodec.encode({ version: 1, defaultWorkingDirectory: "/tmp/a" }),
    ).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/a" });
  });

  it("rejects invalid states at encode time", () => {
    expect(() =>
      imClientSessionStateCodec.encode({ version: 2 as never }),
    ).toThrow(/version must be 1/);
    expect(() =>
      imClientSessionStateCodec.encode({ version: 1, defaultWorkingDirectory: "" }),
    ).toThrow(/defaultWorkingDirectory/);
  });
});
