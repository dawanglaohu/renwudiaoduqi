import io

BS = chr(92)
D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("ANCHOR MISSING in %s:\n---\n%s\n---" % (path, a[:140]))
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

# ─────────────────────────── 06 ───────────────────────────
patch("02-设计/06-系统架构与模块划分.md", [
    # 去掉与三段串联冲突的那半句（pnpm -w check 只能有一个定义）
    ("执行入口统一为根脚本 `pnpm -w check`\n  = `typecheck && lint && format:check && vitest run test/arch`",
     "执行入口统一为根脚本 `pnpm -w check`（构成见下）"),
    # 事件类型文件路径统一
    ("**修订**：`packages/shared/src/api/events.ts` 导出 `EVENT_KINDS` 常量对象（`as const`）\n   与按 kind 收窄的 `EventEnvelope` 判别联合；两组命名形状不变。",
     "**修订**：`packages/shared/src/api/events.ts` 导出 `EVENT_KINDS` 常量对象（`as const`）\n   与按 kind 收窄的 `EventEnvelope` 判别联合；两组命名形状不变。\n   **全文档统一用这一个路径**——08 节与 19 节 M2-T4 里出现的 `shared/src/events.ts` 均以此为准。"),
    # shared/api 文件清单补齐 + Result 类型
    ("请求响应类型集中在 `packages/shared/src/api/`，按资源分文件\n（`tasks.ts` / `runs.ts` / `agents.ts` / `batches.ts` / `devices.ts` / `events.ts`），",
     "请求响应类型集中在 `packages/shared/src/api/`，**按资源分文件且与端点表一一对应**\n（`tasks.ts` / `runs.ts` / `agents.ts` / `batches.ts` / `devices.ts` / `events.ts` /\n`documents.ts` / `gates.ts` / `settings.ts` / `snapshot.ts` / `pair.ts` / `system.ts` /\n`routes.ts` / `shell/bridge-contract.ts`）。\n**新增一类资源 = 新增一个同名文件，不得塞进现有文件**；\n`package.json` 用 subpath `exports` 逐个映射（因为禁止 barrel），"),
])

# ─────────────────────────── 08 ───────────────────────────
patch("02-设计/08-后端架构.md", [
    # 删掉第二张状态码表，统一读 codes.ts 的 defaultHttpStatus
    ("**只有 `http/plugins/90-error-handler.ts` 允许把 code 转成 HTTP 状态码**，\n映射表是 `errors/httpStatus.ts` 里的 `CODE_TO_STATUS`（一张 `ErrorCode` → HTTP 状态码的常量表）。\n未登记的 code 与非 AppError 一律 500 + `E_INTERNAL`。",
     "**只有 `http/plugins/90-error-handler.ts` 允许把 code 转成 HTTP 状态码**，\n且它**直接读 `ERROR_CODES[code].defaultHttpStatus`**（06 节共用约定里那一份）。\n**`errors/` 目录下不得出现第二张状态码表**——出现 `CODE_TO_STATUS` 一类常量即架构测试失败。\n`origin === 'client'` 的条目 daemon 侧不注册；未登记的 code 与非 AppError 一律 500 + `E_INTERNAL`。"),
    # HTTP 状态码数字的禁令改成可执行版本
    ("是全仓**唯一**允许出现 HTTP 状态码数字的地方（除 `sse.ts` 的 200）。",
     "是**主要**允许出现 HTTP 状态码数字的地方。精确禁令：状态码数字**只允许出现在三个文件**——\n`http/plugins/90-error-handler.ts`、`http/sse.ts`（握手 200 与关流用的 401/409）、\n`http/plugins/30-auth.ts`（401/403，因为鉴权发生在 `onRequest` 钩子里、未必经过错误插件）。\n其余文件出现三位数字面量由架构测试判失败。\n**所有成功响应统一 200**，不用 201/204——免得每个路由各挑一个。"),
    # 事件文件路径
    ("信封形状写死，定义放 `packages/shared/src/events.ts` 供两端共用：",
     "信封形状写死，定义放 **`packages/shared/src/api/events.ts`** 供两端共用（路径以 06 节修订 3 为准）："),
    # 快照位置
    ("**派发快照**——每次派发把注册表条目**逐字段深拷贝**进 `runs.launch_spec_json`，\n   **在途运行只读该快照**，运行中的代码禁止再读注册表当前值（E-93）",
     "**派发快照**——每次派发把注册表条目**逐字段深拷贝**进\n   **`dispatch_snapshots.launch_spec_json`**（`runs.snapshot_id` 指向它，见 09 节），\n   **在途运行只读该快照**，运行中的代码禁止再读注册表当前值（E-93）"),
    # 断句损坏
    ("**进程树终止**：spawn 成功即把 pid 写进 `runs.pid` 与内存\n内存中以 `runId` 为键的 `ProcessRegistry` 表。",
     "**进程树终止**：spawn 成功即把 pid 写进 `runs.pid`，并登记到内存中以 `runId` 为键的 `ProcessRegistry`。"),
    # 状态变更事件
    ("- **本产品组**一律 `〈scope〉.〈过去式动词〉`：`run.started` / `run.exited` / `run.aborted` /",
     "- **本产品组**一律 `〈scope〉.〈过去式动词〉`。其中 **`run.state_changed`（payload 带 `from` / `to` / `reason`）\n  是状态机每一次成功迁移都必须发的那一条**——十三个状态若只靠 `run.started` / `run.exited` / `run.aborted`\n  三条，UI 看不到其余十个（见 09 节）。完整清单：`run.state_changed` / `run.started` / `run.exited` / `run.aborted` /"),
])

# ─────────────────────────── 02 ───────────────────────────
patch("00-概览/02-非目标.md", [
    ("**考虑过，因为这个放弃**：其余四个已在本机实测确认可被程序化驱动，\nDeepSeek Harness 本机未安装、形态未确认。",
     "**考虑过，因为这个放弃**：其余四个已在本机实测确认可被程序化驱动。\n**注意理由已被改写**（决策 6 的理由经决策 35 更新）：不是「形态未确认」——\n联网调研已查明它有 `--profile headless` / `--profile acp` 与官方 Python SDK；\n真正的理由是**官方 README 明说会有破坏性变更**（`SESSION_FORMAT_VERSION = 0`，仓库仅 18 天大）\n**且本机未安装、无法验证**。"),
])

print("done")
