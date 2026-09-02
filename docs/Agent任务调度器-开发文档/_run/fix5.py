import io

D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("ANCHOR MISSING in %s:\n---\n%s\n---" % (path, a[:160]))
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

# ─────────────────────────── 10 接口约定 ───────────────────────────
patch("02-设计/10-接口约定.md", [
    # 端点表：health 返回体、删掉语义未定义的 DELETE /documents、补齐缺失端点
    ("| GET | `/api/v1/health` | — | `{ok, uptimeSec}` | none |",
     "| GET | `/api/v1/health` | — | `{ok, uptimeSec, rss, eventIdRange, activeRuns, sseClients, dbSizeBytes}` | none |"),
    ("| DELETE | `/api/v1/documents/:docId` | — | `{detached: true}` | device |\n", ""),
    ("| POST | `/api/v1/documents/:docId/refresh` | — | `{changed, flags}` | device |",
     "| POST | `/api/v1/documents/:docId/refresh` | — | `{changed, flags}` | device |\n"
     "| POST | `/api/v1/documents/:docId/open-reader` | — | `{opened: true}` | device |\n"
     "| PATCH | `/api/v1/documents/:docId/settings` | `{laneCount}` | `{document}` | device |"),
    ("| POST | `/api/v1/runs` | `{taskId, agentId, model?, permissionTier?, idempotencyKey}` | `{run}` | device |",
     "| POST | `/api/v1/runs` | `{taskId, agentId, model?, permissionTier?, baseRef?, worktreeMode?, idempotencyKey}` | `{run}` | device |"),
    ("| GET | `/api/v1/runs/:runId/log` | `?fromSeq&direction&limit` | `{lines, prevCursor, nextCursor}` | device |",
     "| GET | `/api/v1/runs/:runId/log` | `?fromSeq&direction&limit` | `{lines, totalLines, prevCursor, nextCursor}` | device |\n"
     "| GET | `/api/v1/runs/:runId/search` | `?q&limit` | `{hits, truncated, scannedUntilSeq, canceled}` | device |\n"
     "| DELETE | `/api/v1/runs/:runId/logs` | — | `{purgedBytes}` | device |"),
    ("| GET | `/api/v1/tasks/:taskId/landing` | — | `{worktreePath, branchName, diffStat, commands}` | device |",
     "| GET | `/api/v1/tasks/:taskId/landing` | — | `{worktreePath, branchName, diffStat, commands}` | device |\n"
     "| POST | `/api/v1/tasks/:taskId/worktree/cleanup` | — | `{removed: true}` | device |\n"
     "| GET | `/api/v1/system/usage` | — | `{dataDirBytes, byRun[], warnThreshold}` | device |"),
    # 快照形状
    ("| GET | `/api/v1/snapshot` | `?docId` | 全量状态快照 | device |",
     "| GET | `/api/v1/snapshot` | `?docId` | `{documents, batches, tasks, runs, gates, agents, latestEventId}` | device |"),
    # 成功状态码统一
    ("201 Created\n{\n  \"run\": {", "200 OK\n{\n  \"run\": {"),
    # E_PATH_CLASH_QUEUED 改成 200 + run（它其实已经建了 run）
    ("**失败**——同批里有任务抢同一批文件，被排队拦下：\n\n```json\n409 Conflict\n{\n  \"error\": {\n    \"code\": \"E_PATH_CLASH_QUEUED\",\n    \"message\": \"Task contends for paths held by an in-flight run; queued instead of started.\",\n    \"requestId\": \"req_2b91ce04\",\n    \"details\": {\n      \"blockedBy\": \"run_01J8W9\",\n      \"blockingTaskKey\": \"M4-T1\",\n      \"paths\": [\"packages/daemon/src/adapters/\"],\n      \"note\": \"Worktree isolation does not release this; waits until the blocker reaches landed.\"\n    }\n  }\n}\n```",
     "**失败**——模型名被 agent 拒绝（派发已发出、agent 报错回来）：\n\n```json\n422 Unprocessable Entity\n{\n  \"error\": {\n    \"code\": \"E_MODEL_INVALID\",\n    \"message\": \"Agent 'codex' rejected model name; passed through verbatim.\",\n    \"requestId\": \"req_2b91ce04\",\n    \"details\": {\n      \"agentId\": \"codex\",\n      \"model\": \"o4-mini\",\n      \"agentStderrTail\": \"unknown model: o4-mini\"\n    }\n  }\n}\n```\n\n> **路径冲突不是失败。** 同批里抢同一批文件时 run **已经建好并落库**，\n> 只是停在 `queued`，所以返回 **200 + `{run}`**，`run.queuedReason` 说明被谁挡住——\n> 返回错误信封会让客户端拿不到 `runId` 从而无法跟踪这次派发（E-46）。"),
    # 幂等表：既有 run 放 details
    ("重复提交返回既有 run 并置 `409 E_RUN_ALREADY_EXISTS`",
     "重复提交置 `409 E_RUN_ALREADY_EXISTS`，**既有 run 放在 `details.run` 里**（失败信封没有别的位置放它）"),
    # 字段级契约补三行
    ("| `gateOverrides` | object | 否 | 仅本批次生效，不改全局设置 | — |",
     "| `gateOverrides` | object | 否 | `{dispatch?, review?}`，值域同下；**不含 `landing`**，仅本批次生效不改全局 | — |\n"
     "| `dispatch` / `review`（闸门） | enum | 是 | `auto` / `manual` | — |\n"
     "| `landing`（闸门） | enum | 是 | **固定 `manual`**；传其他值直接 `E_VALIDATION`（E-53） | — |\n"
     "| `baseRef` | object | 否 | `{kind:'head'\\|'upstreamBranch', taskKey?}`，默认 `head`（E-70） | — |\n"
     "| `worktreeMode` | enum | 否 | `fresh` / `reuse`，默认 `fresh`（E-121） | — |\n"
     "| `q`（会话查找） | string | 是 | 非空；服务端硬超时 10s、结果上限 500 条（E-219） | 1–200 |"),
    # 错误码表：加 origin 列与新增码
    ("| code | HTTP | 可重试 | 含义 |\n|---|---|---|---|",
     "`origin='client'` 的三条**不由 daemon 产生**，HTTP 列为 `—`；它们是前端在\n网络不可达、请求超时、壳能力缺失时使用的码，登记在同一份枚举里以免前端自造字面量。\n\n| code | origin | HTTP | 可重试 | 含义 |\n|---|---|---|---|---|"),
])

# 错误码表逐行补 origin 列（server），并追加新码
p = D + "02-设计/10-接口约定.md"
s = io.open(p, encoding="utf-8").read()
import re
def add_origin(m):
    return "| `%s` | server | %s |" % (m.group(1), m.group(2))
s2 = re.sub(r"\| `(E_[A-Z_]+)` \| (\d{3} \| [是否] \| [^|]*)\|", add_origin, s)
extra = (
    "| `E_INVALID_STATE_TRANSITION` | server | 500 | 否 | 状态机白名单之外的迁移，属实现缺陷（09 节） |\n"
    "| `E_GATE_ALREADY_DECIDED` | server | 409 | 否 | 闸门已由另一端确认，返回既有记录（E-57） |\n"
    "| `E_LOG_PURGED` | server | 410 | 否 | 会话正文已被保留策略清理，与「文件丢失」区分（E-221） |\n"
    "| `E_NETWORK` | client | — | 是 | 网络不可达，前端产生 |\n"
    "| `E_TIMEOUT` | client | — | 是 | 请求超时，前端产生 |\n"
    "| `E_SHELL_UNAVAILABLE` | client | — | 否 | 壳能力缺失（无原生通知/安全存储），前端产生 |\n"
    "| `E_DEVICE_REVOKED` | server | 401 | 否 | 该设备令牌已被吊销（E-127） |\n"
)
anchor = "| `E_INTERNAL` | server | 500 | 否 | 未登记的异常，兜底 |\n"
if anchor not in s2:
    raise SystemExit("E_INTERNAL row anchor not found after origin rewrite")
s2 = s2.replace(anchor, extra + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s2)
print("patched 02-设计/10-接口约定.md (error table)")
