import crypto from "node:crypto";

function trimToAlnumEdges(value: string): string {
  return value.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

export function toPiSessionId(bridgeSessionId: string): string {
  const normalized = trimToAlnumEdges(bridgeSessionId.replace(/[^A-Za-z0-9._-]+/g, "."));
  if (normalized && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(normalized)) {
    return normalized;
  }

  const digest = crypto.createHash("sha256").update(bridgeSessionId).digest("hex").slice(0, 24);
  return `bridge-${digest}`;
}
