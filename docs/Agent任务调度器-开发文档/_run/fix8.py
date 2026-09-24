import io

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            print("  SKIP: " + a[:60]) or None
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

# ── 19 节：补边界引用 + 把新端点挂进对应任务的产出（否则 M2-T6 的路由一致性断言第一天就挂）──
patch("04-执行/19-模块任务拆分.md", [
    # M3-T1：加分层函数与设置项
    ("| `service/docs.ts` 的唯一解析适配器、`repo/documents.ts` |",
     "| `service/docs.ts` 的唯一解析适配器、`domain/layer-of.ts`（批次分层纯函数）、`repo/documents.ts` |"),
    ("4) 解析失败或文件被删时保留全部既有记录与快照，置 `is_source_readable=0` 并冻结新派发，**不清空任何数据**（E-82） |",
     "4) 解析失败或文件被删时保留全部既有记录与快照，置 `is_source_readable=0` 并冻结新派发，**不清空任何数据**（E-82） "
     "5) **批次由本产品按 `deps` 拓扑分层算出**（层号 = 最长前驱链长度，无前驱为 0，显示号 = 层号 + 1），"
     "规则与阅读器逐字一致且收敛在这一个模块内；上游日后真导出 `batchNo` 时只改这一个函数（E-246） "
     "6) 阅读器那条窗口数 localStorage 键**不存在也不读**，本产品一律用自己的 `documents.lane_count` 设置（E-247） |"),
    # M3-T2：成环/幽灵/位移/单层
    ("3) 多份文档按文档路径 + 指纹隔离，任务 id 不跨项目冲突，列表按文档分组不混排（E-21、E-87） |",
     "3) 多份文档按文档路径 + 指纹隔离，任务 id 不跨项目冲突，列表按文档分组不混排（E-21、E-87） "
     "4) 依赖成环时与上游同规则**就地截断为层 0**（落进第 1 批），并在导入报告与 UI 列出环上任务 id，该批派发前**强制人工确认**（E-241） "
     "5) `deps` 指向不存在的任务 id 时只计入存在的前驱，**被忽略的幽灵 id 必须在导入报告里列出**（E-242） "
     "6) 批次号**不作持久标识**，每次导入按当前分层重算；历史派发记录只认任务 id 与快照（E-243） "
     "7) 全部任务无依赖时只有「第 1 批」，界面照常按批次呈现，**不退化成无批次列表**（E-244） |"),
    # M3-T4：不碰浏览器存储 + open-reader 路由
    ("| `system.docs_changed` 事件、接管横幅数据、打开原阅读器的入口 |",
     "| `system.docs_changed` 事件、接管横幅数据、`http/routes/documents.ts`（含 `open-reader` 与 `settings` 两个端点） |"),
    ("4) 文档目录被移动或重命名时提示「文档路径不可用，请重新定位」，任务记录、快照、会话指针全部保留（E-86） |",
     "4) 文档目录被移动或重命名时提示「文档路径不可用，请重新定位」，任务记录、快照、会话指针全部保留（E-86） "
     "5) 调度器**不读不写任何浏览器存储**；阅读器里手点三态与手调窗口数都不影响调度器（E-249） |"),
    # M8-T1：窗口数是上限
    ("4) 纯函数实现，可被直接单测 | 1d |",
     "4) 纯函数实现，可被直接单测 "
     "5) 用户设的窗口数只是**上限**，实际并发取 min(设置, 每 agent 上限, 机器资源, 路径冲突)，"
     "**设置值不被运行时静默改写**（E-245） | 1d |"),
    # M9-T14：窗口数设置项 + 两边互不影响的提示
    ("7) 接入第 5/6 个 agent 只需填两字符短码，**不新增任何资源文件**（E-185） | 2d |",
     "7) 接入第 5/6 个 agent 只需填两字符短码，**不新增任何资源文件**（E-185） "
     "8) 并行窗口数是本产品自己的设置（默认 2，值域 1–6，按文档持久化），"
     "设置项旁注明「此值只属于调度器，与阅读器互不影响」（E-248） | 2d |"),
    # M1-T5：usage 端点
    ("| `disk-watch` job、`deleteByPath` / `truncate` / `usage` 三个不带业务语义的原语 |",
     "| `disk-watch` job、`deleteByPath` / `truncate` / `usage` 三个不带业务语义的原语、`http/routes/system.ts` |"),
    # M5-T4：worktree cleanup 端点
    ("| `GET /tasks/:id/landing` 的数据 |",
     "| `workspace/landing.ts`、`http/routes/tasks.ts`（含 `landing` 与 `worktree/cleanup` 两个端点） |"),
    # M6-T9：search 与 logs 删除端点
    ("| 保留策略、`searchInRun()` |",
     "| 保留策略、`searchInRun()`、`http/routes/runs.ts` 的 `search` 与 `DELETE logs` 两个端点 |"),
    # M4-T4：agents 路由
    ("| 启动期探测、`agent.availability_changed` 事件 |",
     "| 启动期探测、`agent.availability_changed` 事件、`http/routes/agents.ts`（列表 / PATCH / probe / models 四个端点） |"),
    # M8-T3：snapshot 与 batches 路由
    ("| `scheduler-tick` job、`POST /runs`、`POST /batches/:id/start` |",
     "| `scheduler-tick` job、`http/routes/runs.ts`、`http/routes/batches.ts`、`http/routes/snapshot.ts` |"),
    # M2-T6：把两个一致性脚本挂进产出
    ("| 各路由的 JSON Schema、`test/arch/routes.test.ts`、键清单常量 |",
     "| 各路由的 JSON Schema、`test/arch/routes.test.ts`、键清单常量、`scripts/check-error-codes.mjs` |"),
    ("4) 所有请求体 Schema 统一 `additionalProperties:false`，多余字段返回 400 并列出字段名，不静默丢弃（E-217） |",
     "4) 所有请求体 Schema 统一 `additionalProperties:false`，多余字段返回 400 并列出字段名，不静默丢弃（E-217） "
     "5) `check-error-codes.mjs` 断言 `codes.ts` 的键集合与 10 节错误码表逐行一致，"
     "**方向是「文档为源、代码为投影」**，不一致即 `pnpm -w check` 失败 |"),
    # M1-T8：把 N 写成具体值
    ("4) 内存只保留最近 N 条事件的环形缓冲，单条 payload 超 32 KiB 入缓冲前替换为引用（E-142） |",
     "4) 内存只保留最近 **5000** 条事件的环形缓冲（与 M2-T4 的重放窗口是同一个缓冲，**不另开第二个**），"
     "单条 payload 超 32 KiB 入缓冲前替换为引用（E-142） |"),
])
print("done")
