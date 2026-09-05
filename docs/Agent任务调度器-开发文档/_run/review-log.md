# 2026-09-05 unattended-run 1.1.0 更新验收

VERDICT: pass
BLOCKING: none

## 更新范围

- 安装2026-09-05更新的1.1.0八个工具，保留24节、78任务、271边界；工具来源和局部补丁见 tool-upgrade.json。
- 修正新版机械检查发现的3处通配范围与3处能力前置遗漏。
- 独立审查第一轮指出M3旧指纹与新版导出不一致、未实施任务错误进入代码PR审查、历史落地复验要求继续旧PR；已修复并在第二轮通过复核。
- M3采用schema1、三处契约哈希校验、版本化指纹与派发快照；人工依赖确认不能绕过文档契约门槛；M7保持只读裁定。
- 源文档及对应阅读器、派发导出、知识库已同步。

## 验证证据

| 检查 | 结果 |
|---|---|
| review.py / maintain_docs sync | 阻断0，建议0，信息4 |
| 项目实际工具副本运行官方 test_maintenance.py | 23测试通过；验证中断恢复、陈旧证据拒绝、版本一致性、局部同步、幂等重建等 |
| _run/tests/test_prompt_routing.py | 7测试通过；待派且已复核、同步锁、历史done复验、在途续做、导出同源 |
| 现有daemon五个Vitest文件 | 24测试通过，包括真实Node20门禁和Node22常驻锁 |
| pnpm exec tsc -b --noEmit | 通过 |
| pnpm lint / pnpm exec biome ci . | 通过 |
| 离线Chrome阅读器 | 无JavaScript错误，78任务三类提示词与共享核心逐字一致，真实点击契约审查不推进实施状态 |
| 知识库保护区 | 359篇笔记的447个code/notes/verify区块保持原文 |
| git diff --cached --check | 通过 |

## 复核边界

本次独立审查通过的是文档工具升级及关联契约修补。仅M1-T1与M4-T1完成当前版本的任务契约复核并复验既有代码；证据存 task-reviews.json，历史PR分别为#2（51edc09）与#4（791328c），GitHub已确认MERGED。两任务没有新增代码义务，原有status:done与实施回填保留；以实际复验结果运行 --landed 清除复验标记。

其余76个任务不自动登记语义通过；开发前逐任务使用 status / verify，不能把结构检查通过当作代码验收或CI通过。E-250～E-252是既有已登记文档维护边界，无实施任务兜底，保留风险说明；268条边界由任务直接覆盖。macOS/Linux发布和GUI证据仍按项目原有平台验收要求获取，本次未宣称执行。

## 复现

在项目根运行：

```text
python docs/Agent任务调度器-开发文档/_run/maintain_docs.py docs/Agent任务调度器-开发文档 build
python -B -m unittest discover -s docs/Agent任务调度器-开发文档/_run/tests -p test_prompt_routing.py -v
python docs/Agent任务调度器-开发文档/_run/build_vault.py docs/Agent任务调度器-开发文档 --check
```

完整原始补丁与前后源条款存 patches/docs-toolkit-1.1.0.json；本地生成的diff预览不进入Git。只提交本次文档、工具及关联产物，仓库根既有planning文件未纳入提交。
