# Azure OpenAI Responses `response.failed` 调查记录

- 调查日期：2026-08-01
- 受影响组件：Pi Coding Agent / `@earendil-works/pi-ai` 0.82.1、Agent Bridge 0.4.2、Azure OpenAI Responses API
- Azure 资源：`gaoqi-mdyai7ah-eastus2`（East US 2）
- Azure 部署：`gpt-5.6-sol`，`GlobalStandard`，capacity 250
- 最终结论：主要的“空错误”是 Azure OpenAI 流式请求的限流。HTTP SSE 连接先以 200 建立，随后 Azure 发送 `response.failed`，但 `response.error` 和 `response.incomplete_details` 都为空。Azure Monitor 将同一时间窗口内的请求统计为 HTTP 429，并且初始 HTTP Response Header 携带 `Retry-After`。这不是网络代理导致的连接中断。

## 1. 初始现象

Agent Bridge 收到 Pi RPC 的 assistant error：

```text
The agent run failed.
Unknown error (no error details in response)
```

Pi session JSONL 中对应消息具有：

```json
{
  "stopReason": "error",
  "responseId": "resp_...",
  "usage": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 0
  },
  "errorMessage": "Unknown error (no error details in response)"
}
```

多个长上下文会话都出现过该问题。出错前上下文大约在 50K 到 180K tokens；模型目录中 `gpt-5.6-sol` 的 context window 为约 1.1M，因此不是上下文窗口溢出。

## 2. Pi 原始错误处理路径

安装版本中的主要路径为：

```text
@earendil-works/pi-coding-agent
  -> @earendil-works/pi-ai/dist/api/azure-openai-responses.js
  -> @earendil-works/pi-ai/dist/api/openai-responses-shared.js
```

`openai-responses-shared` 对 `response.failed` 的原始处理逻辑只读取：

```ts
const error = event.response?.error;
const details = event.response?.incomplete_details;
const msg = error
  ? `${error.code || "unknown"}: ${error.message || "no message"}`
  : details?.reason
    ? `incomplete: ${details.reason}`
    : "Unknown error (no error details in response)";
throw new Error(msg);
```

因此当 Azure 返回：

```json
{
  "error": null,
  "incomplete_details": null
}
```

Pi 只能显示 `Unknown error`。

## 3. 临时诊断日志是如何添加的

> 本节记录临时调查补丁。补丁在调查结束后已经回滚，不应当作为正式实现使用。

### 3.1 SSE 终止事件诊断

临时修改：

```text
.../pi-ai/dist/api/openai-responses-shared.js
```

记录内容包括：

- SSE 事件总数；
- 最近 20 个 SSE event type；
- `response.failed` 的脱敏预览；
- 是否截断；
- 序列化后的原始长度。

脱敏字段包括：

- `authorization`
- `api-key`
- `cookie`
- `input`
- `instructions`
- `encrypted_content`

最终捕获到的关键结构：

```json
{
  "eventCount": 2,
  "recentEventTypes": [
    "response.created",
    "response.failed"
  ],
  "event": {
    "type": "response.failed",
    "sequence_number": 1,
    "response": {
      "id": "resp_...",
      "status": "failed",
      "error": null,
      "incomplete_details": null,
      "output": [],
      "usage": null,
      "model": "gpt-5.6-sol",
      "store": false,
      "service_tier": "auto"
    }
  }
}
```

这说明错误不是 EOF 或 socket reset，而是 Azure 明确发送了合法的 `response.failed` SSE 终止事件。

### 3.2 HTTP Response 元数据

临时修改：

```text
.../pi-ai/dist/api/azure-openai-responses.js
```

在 `client.responses.create(...).withResponse()` 返回后，从 HTTP Response Header 中提取：

```ts
{
  status: response.status,
  requestId: headers["x-request-id"],
  apimRequestId: headers["apim-request-id"],
  azureRequestId: headers["x-ms-request-id"],
  region: headers["x-ms-region"],
  date: headers.date,
  retryAfter: headers["retry-after"]
}
```

实际样本：

```json
{
  "status": 200,
  "requestId": "f56212f7-6e80-4c6c-8af6-04b252f1dec5",
  "apimRequestId": "f56212f7-6e80-4c6c-8af6-04b252f1dec5",
  "region": "East US 2",
  "date": "Sat, 01 Aug 2026 14:56:09 GMT",
  "retryAfter": "10"
}
```

其他失败请求的 `Retry-After` 样本包括：

```text
1, 2, 3, 4, 5, 6, 10, 11, 17, 19, 21 seconds
```

### 3.3 临时日志补丁自身出现的问题

第一版诊断代码把完整 event 序列化后截断到约 12,000 字符，然后错误地对截断后的 JSON 再执行 `JSON.parse()`，导致：

```text
Unterminated string in JSON at position 12025
```

该错误固定出现在截断边界附近，是诊断代码自身的 bug，不是 Azure 返回了非法 JSON。

后续修复为：

- 截断后的内容只作为字符串，不再调用 `JSON.parse`；
- 预览缩短到 4,000 字符并保留头尾；
- 移除写入 Pi stderr 的重复 `console.error`。

另一次为加载补丁而对 Pi 子进程发送 `SIGTERM`，产生：

```text
pi RPC process exited (code 143)
```

其中 `143 = 128 + SIGTERM(15)`。Agent Bridge 会累积 Pi stderr，并在进程退出时一次性附加到退出错误，因此当时出现了包含多条历史错误的超长消息。该操作和相关临时代码均不应作为正式方案。

## 4. 代理排查

运行环境中存在：

```text
http_proxy=http://127.0.0.1:7897
https_proxy=http://127.0.0.1:7897
all_proxy=http://127.0.0.1:7897
```

Mihomo 为 Global 模式。调查包括：

### 4.1 未认证 HTTPS 连通性测试

对 Azure endpoint 连续执行 15 次代理请求和 15 次直连请求：

```bash
curl -sS -o /dev/null \
  --connect-timeout 8 \
  --max-time 15 \
  https://<resource>.openai.azure.com/openai/v1/models
```

结果：

- 代理：15/15 收到 HTTP 401，约 0.85–2.63 秒；
- 直连：15/15 收到 HTTP 401，约 1.30–4.69 秒；
- 没有 reset、EOF 或 timeout。

401 是因为该连通性请求故意没有携带 API Key，说明 TLS 和 HTTP 路径可达。

### 4.2 已认证 SSE 测试

分别经过代理和直连发送最小 Responses 流请求，每种 5 次：

```json
{
  "model": "gpt-5.6-sol",
  "input": "Reply with exactly OK.",
  "stream": true,
  "store": false,
  "max_output_tokens": 16
}
```

结果：

- 代理：5/5 `response.completed`；
- 直连：5/5 `response.completed`；
- 两组均没有 `response.failed`。

继续在直连模式测试 `max_output_tokens`：

```text
128000, 32768, 8192, 16
```

每档 3 次，共 12 次，全部 `response.completed`。因此仅仅把 `max_output_tokens` 设为 128K 并不足以单独复现问题。

### 4.3 NO_PROXY A/B

Agent Coding 1 曾临时使用：

```text
NO_PROXY=127.0.0.1,localhost,.openai.azure.com
no_proxy=127.0.0.1,localhost,.openai.azure.com
```

即 Azure 直连、其他流量仍走代理。直连期间仍出现相同的：

```text
HTTP 200
response.created
response.failed
error=null
Retry-After present
```

Agent Coding 3 经过代理时也出现相同现象。因此代理不是该批空错误的根因。

## 5. Azure Monitor 证据

资源：

```text
/subscriptions/5809f91d-692c-4957-a01b-d9dab70a90b7/
resourceGroups/pdc-serviceme-next-test/
providers/Microsoft.CognitiveServices/accounts/gaoqi-mdyai7ah-eastus2
```

查询命令形式：

```bash
az monitor metrics list \
  --resource "$RESOURCE_ID" \
  --metric AzureOpenAIRequests \
  --interval PT1M \
  --start-time '2026-08-01T14:50:00Z' \
  --end-time '2026-08-01T15:10:00Z' \
  --aggregation Count \
  --filter "ModelDeploymentName eq 'gpt-5.6-sol' and StatusCode eq '*' and ApiName eq '*' and OperationName eq '*' and StreamType eq '*'"
```

Azure Monitor 返回：

```text
OperationName = create-response
StreamType = Streaming
ModelDeploymentName = gpt-5.6-sol
```

关键统计：

| UTC minute | HTTP 200 | HTTP 429 |
|---|---:|---:|
| 14:55 | 5 | 1 |
| 14:56 | 3 | 2 |
| 14:57 | 2 | 4 |
| 14:58 | 1 | 1 |
| 14:59 | 2 | 0 |
| 15:00 | 3 | 2 |
| 15:01 | 2 | 3 |

Agent Coding 3 在 14:56–14:57 UTC 连续失败，与 Azure Monitor 的 429 高峰完全重叠。

Azure deployment 配置：

```json
{
  "name": "gpt-5.6-sol",
  "sku": "GlobalStandard",
  "capacity": 250,
  "rateLimits": [
    {
      "key": "request",
      "count": 250,
      "renewalPeriod": 60
    },
    {
      "key": "token",
      "count": 250000,
      "renewalPeriod": 60
    }
  ]
}
```

也就是约 250K tokens/minute。多个约 150K–180K 上下文的 Agent 会话同时工作，且每次工具调用后都需要再次调用模型，容易触发部署级 TPM 限流。

## 6. 为什么 HTTP 客户端看到 200，而 Azure Monitor 记录 429

Responses API 是 SSE 流式协议。HTTP headers 一旦发送，状态码就已经固定为 200。之后如果 Azure 内部调度或容量检查失败，无法把已发送的 HTTP 状态改成 429，只能在流中发送失败事件。

本次表现为：

```text
HTTP envelope: 200 OK + Retry-After
SSE terminal event: response.failed
Azure telemetry classification: 429
```

因此不能在客户端把真实 HTTP status 伪造为 429；应分别记录：

```text
httpStatus = 200
streamStatus = failed
retryAfter = N seconds
inferred transient condition = throttling/rate limiting
```

## 7. 对上游 Pi PR 的建议

正式实现不应记录完整 raw event。建议：

1. 为 `response.failed` 定义结构化内部错误，保留：
   - response ID；
   - response status；
   - provider error code/message；
   - incomplete reason；
   - sequence number。
2. Azure provider 将 HTTP response headers 与 stream failure 合并，安全记录：
   - HTTP 200；
   - `Retry-After`；
   - request/APIM request ID；
   - region；
   - stream status。
3. 在 `AssistantMessage` 中增加可选结构化重试提示，例如：

   ```ts
   retryAfterMs?: number;
   ```

4. assistant-level retry 在指数退避和服务端建议之间取较大值：

   ```ts
   delayMs = Math.max(exponentialDelayMs, response.retryAfterMs ?? 0);
   ```

5. 继续保留最大等待时间和 AbortSignal 支持。
6. 只有 `response.failed` 且存在合法 `Retry-After` 时才设置该提示；正常完成响应即使携带类似 header，也不能被当成错误。
7. diagnostics 禁止包含 prompt、instructions、tools、API Key、Authorization 或完整响应对象。

相关上游问题：

- `#1935`：`response.failed` 错误详情不足；
- `#4232`：Azure 错误未触发自动重试；
- `#6019`：Responses mid-stream retryable error 未重试；
- `#4377`：Retry-After 未被正确遵守。

## 8. Agent Bridge 飞书 `socket hang up`

调查过程中还遇到：

```text
[agent-bridge error] Message delivery failed
socket hang up
```

该错误发生在 Agent Bridge 向飞书发送消息的 HTTP 链路，与 Azure 模型 `response.failed` 是两个独立问题。一次原始发送失败后，失败通知本身能够成功发送，符合短暂网络连接重置的特征。

曾临时在 `FeishuClient` 中增加：

- ECONNRESET/timeout/5xx/429 重试；
- 250ms、750ms backoff；
- 使用 Feishu message UUID 保证重试幂等；
- 安全的错误元数据日志。

该修改也属于本次临时源码修改，按要求在调查结束后回滚。

## 9. 最终建议

短期：

1. 提高 `gpt-5.6-sol` deployment 的 TPM capacity；
2. 减少多个长上下文 Agent 在同一 deployment 上并发；
3. 适当降低默认 `max_output_tokens`，但它不是唯一触发因素；
4. 在 Pi 中正确处理 `HTTP 200 + response.failed + Retry-After` 并自动重试。

长期：向 Pi 上游提交结构化 stream failure 和 Retry-After PR，而不是继续使用本次临时 raw logging patch。
