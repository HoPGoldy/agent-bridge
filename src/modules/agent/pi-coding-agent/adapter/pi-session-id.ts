import crypto from "node:crypto";

function trimToAlnumEdges(value: string): string {
  return value.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

export function toPiSessionId(agentSessionId: string): string {
  const normalized = trimToAlnumEdges(agentSessionId.replace(/[^A-Za-z0-9._-]+/g, "."));
  if (normalized && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(normalized)) {
    return normalized;
  }

  const digest = crypto.createHash("sha256").update(agentSessionId).digest("hex").slice(0, 24);
  return `agent-${digest}`;
}
