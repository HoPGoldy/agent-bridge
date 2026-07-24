# Memory Analysis: OpenClaw, Hermes, and Agent Bridge

This document summarizes a quick memory-usage investigation across:

1. OpenClaw
2. Hermes
3. This project's `agent-bridge`

It focuses on **observed resident memory (RSS)** from public issue reports plus **local measurements** on the current machine.

> Notes
>
> - The OpenClaw and Hermes numbers below are **not official idle benchmarks**. They come from public GitHub issues and reflect real user environments, sometimes including leaks, regressions, large session stores, or multi-session workloads.
> - The local `agent-bridge` analysis was done on this machine and is more representative of the current deployment here.

---

## 1. OpenClaw memory observations

### Public reports found

#### A. Fresh-start / baseline gateway RSS around **594 MB to 723 MB**
- Issue: **Gateway RSS regression on 2026.4.15 — fresh cold-start baseline 700MB+ on macOS ARM64, steady climb regardless of workload**
- Link: <https://github.com/openclaw/openclaw/issues/70717>

Reported values in the issue body:
- Post-nightly-bounce baseline: **594 MB**
- Mid-session restart baseline: **723 MB**
- Older version baseline in same environment: **~400 MB**

Interpretation:
- In at least one real-world deployment, OpenClaw gateway baseline memory was already in the **hundreds of MB** even before heavy ongoing use.

#### B. Gateway restart baseline around **350 MB**, later leaking to multi-GB
- Issue: **Critical: Gateway Memory Leak — RSS grows from 350MB to 15.5GB over days, causing repeated OOM crashes**
- Link: <https://github.com/openclaw/openclaw/issues/91588>

Reported values in the issue body:
- Immediately after restart: **~350 MB**
- Before restart: **15.5 GB**

Interpretation:
- This does **not** prove that OpenClaw always idles at 350 MB, but it does show a reported real-world gateway baseline in that rough range.

### OpenClaw summary

Based on the public reports found during this investigation:
- OpenClaw gateway memory appears commonly reported in the **~350 MB to ~700+ MB** range at baseline in real deployments.
- Some reports also show severe long-running growth and leaks.

---

## 2. Hermes memory observations

### Public reports found

#### A. Gateway base around **700 MB**
- Issue: **Memory leak: Gateway accumulates ~8GB RAM in 1h with 2 active Discord sessions**
- Link: <https://github.com/NousResearch/hermes-agent/issues/18438>

Reported values in the issue body:
- Memory grows from **~700 MB base** to **8 GB in ~1 hour**

Interpretation:
- In that environment, Hermes gateway baseline was already around **700 MB** before leak/growth under active load.

#### B. Fresh TUI session baseline around **700 MB**
- Issue: **[Bug]: TUI Gateway progressive RSS leak — 8 concurrent sessions, 7.4 GB tui_gateway RSS**
- Link: <https://github.com/NousResearch/hermes-agent/issues/62743>

Reported values in the issue body:
- A fresh session starts at **~700 MB baseline**

Interpretation:
- Hermes TUI gateway in that report has a substantial starting footprint, before long-running accumulation.

#### C. Desktop backend around **~1 GB on startup even when idle**
- Issue: **Desktop TUI Gateway Python process resident memory ~1GB on startup (state.db 469MB + pymalloc)**
- Link: <https://github.com/NousResearch/hermes-agent/issues/53415>

Reported values in the issue body:
- Python dashboard/backend process uses **~1 GB RSS on startup**, even when idle

Interpretation:
- This is not a minimal gateway deployment; it is a desktop/backend scenario with a larger session store and Python allocator effects. Still, it shows that Hermes-family deployments can have very large baseline RSS.

### Hermes summary

Based on the public reports found during this investigation:
- Hermes memory is also commonly reported in the **hundreds of MB**, often around **~700 MB baseline** for gateway/TUI scenarios.
- Desktop/backend scenarios can reach **~1 GB** at startup.
- Like OpenClaw, Hermes also has public reports of significant long-running growth or leaks.

---

## 3. Local `agent-bridge` analysis

### Deployment context on this machine

The running `agent-bridge` channels here are configured as:
- `coding-1`: `feishu` + `pi-coding-agent`
- `coding-2`: `feishu` + `pi-coding-agent`
- `coding-3`: `feishu` + `pi-coding-agent`
- `assistant`: `feishu` + `pi-coding-agent`

So the live `agent-bridge` processes we inspected are **Feishu-backed** channels, not a generic minimal bridge.

### Key process observations

For `coding-2`, the main bridge process was:
- `node ... agent-bridge start coding-2`
- RSS: about **95.2 MiB**

Local `smaps_rollup` for that process showed:
- `Rss`: **97,472 kB**
- `Pss`: **57,508 kB**
- `Private_Dirty`: **47,348 kB**
- `Shared_Clean`: **49,376 kB**

Interpretation:
- The process **does** show about **95 MiB RSS** in `ps`
- But not all of that is private memory; a noticeable portion is shared file-backed pages
- So the process *looks* like ~95 MiB RSS, while its more exclusive footprint is lower than raw RSS suggests

### Important structural finding: `agent-bridge` also launches `pi`

The bridge process is not the whole runtime.

Current process trees showed patterns like:
- `bash`
  - `node ... agent-bridge start coding-2`
    - `pi`

So in this deployment:
- `agent-bridge` is the bridge/runtime shell
- `pi` is the actual agent subprocess

This means the total end-to-end memory of a live channel can be much higher than the bridge process alone.

For example, at one point `coding-2` had roughly:
- `agent-bridge` Node process: **~95 MiB RSS**
- child `pi` process: **~163.5 MiB RSS**
- shell: **~3.4 MiB RSS**

Total rough chain for that active channel:
- **~262 MiB RSS**

---

## 4. Why can `agent-bridge` itself use ~90+ MiB?

### Short answer

Because it is **not** just a tiny text-forwarding script.

It is a long-running Node.js gateway process that:
- loads IM platform SDKs
- maintains connections / adapters
- handles typing/progress state
- handles attachments and media transfer
- persists session bindings
- manages agent session lifecycle
- launches and communicates with `pi --mode rpc`

### Code-level findings

#### A. Client registry loads multiple client modules from top level
File:
- `src/modules/client/index.ts`

It imports all client modules at module top level:
- `./feishu`
- `./wecom`
- `./weixin`

That means this is **not fully lazy-loaded by channel type**.

#### B. Feishu path pulls in a heavy SDK
File:
- `src/modules/client/feishu/adapter/feishu-client.ts`

Top-level import:
- `import * as Lark from "@larksuiteoapi/node-sdk";`

The Feishu client also creates both:
- `Lark.createLarkChannel(...)`
- `new Lark.Client(...)`

So a Feishu-backed channel is carrying a substantial SDK/runtime layer.

#### C. Other client stacks are also present in the code path
Examples:
- `src/modules/client/weixin/adapter/weixin-client.ts`
  - imports `@openilink/openilink-sdk-node`
- `src/modules/client/wecom/adapter/wecom-client.ts`
  - imports `@wecom/aibot-node-sdk`
- `src/modules/client/weixin/index.ts`
  - statically imports `loginWithWeixinQr`, which also depends on OpenILink

This reinforces that `agent-bridge` is built as a multi-platform gateway rather than a minimal single-platform runtime.

---

## 5. Local SDK memory measurements

We measured process RSS using small one-off local scripts.

### Empty Node.js process
Approximate RSS:
- **43.4 MB**

### After importing Feishu SDK only
Command-level measurement showed approximately:
- start: **43.4 MB**
- after `@larksuiteoapi/node-sdk`: **110.4 MB**

Approximate increase:
- **+67 MB RSS**

### After importing Weixin and WeCom SDKs only
Approximate measurement:
- start: **43.4 MB**
- after `@openilink/openilink-sdk-node`: **53.8 MB**
- after `@wecom/aibot-node-sdk`: **69.7 MB**

### Combined import measurement
Approximate measurement:
- start: **43.4 MB**
- after Lark: **110.4 MB**
- after OpenILink: **111.3 MB**
- after WeCom: **111.8 MB**

Interpretation:
- The dominant jump in this environment is the **Feishu/Lark SDK**
- The bridge's ~90+ MiB RSS is therefore largely explained by:
  - Node.js + V8 baseline
  - Feishu SDK load cost
  - creation of long-lived gateway/client objects
- The bridge's own business state (`Map`s, queues, bindings, progress state) does **not** appear large enough to explain tens of MB by itself

---

## 6. Main conclusion

### Compared with OpenClaw and Hermes

Public reports suggest that:
- OpenClaw and Hermes often run in the **hundreds of MB** for full gateway/TUI/desktop scenarios
- therefore, a live `agent-bridge` + `pi` channel being in the **hundreds of MB total** is not out of family with other agent stacks

### For `agent-bridge` specifically

The surprising part was that the bridge alone showed about **90+ MiB RSS**.

The local investigation suggests the main reasons are:
1. **Feishu SDK load cost is large**
2. **client modules are not fully lazy-loaded by channel type**
3. **each channel runs as its own Node process**, duplicating that baseline
4. **raw RSS overstates exclusive memory**, because some pages are shared

So the best concise explanation is:

> `agent-bridge` is not just a tiny message forwarder. In the current Feishu-based deployment, it behaves more like a small long-running IM gateway, and the Feishu SDK is the biggest visible contributor to the ~90+ MiB RSS baseline.

---

## 7. Possible follow-up optimization directions

If memory reduction becomes important, the most promising areas are:

1. **Lazy-load client modules by configured channel type**
   - avoid top-level eager imports of all client modules

2. **Move heavy SDK imports deeper**
   - import Feishu / Weixin / WeCom SDKs only when that adapter is actually started

3. **Split platform-specific entry paths**
   - a Feishu-only runtime should not need to carry unrelated client stacks

4. **Measure PSS in addition to RSS**
   - especially when many similar Node processes are running on the same machine

---

## Source links

### OpenClaw
- <https://github.com/openclaw/openclaw/issues/70717>
- <https://github.com/openclaw/openclaw/issues/91588>

### Hermes
- <https://github.com/NousResearch/hermes-agent/issues/18438>
- <https://github.com/NousResearch/hermes-agent/issues/62743>
- <https://github.com/NousResearch/hermes-agent/issues/53415>
