---
batch: 8
tasks: M10-T4, M4-T14, M6-T10, M6-T4, M6-T7, M6-T9, M7-T2, M8-T10, M8-T5, M9-T5
date: 2026-09-29
verdict: open
tests: skipped
skip_reason: 本记录登记 Claude 启动与事件接线的定点返工，未执行整批收口。
note: Claude 前台运行在隔离配置下因参数缺失退出；补参数后仍因 stdin 未投递而无产出。批次保持 open，返工落地后另行整体验收。
repair_schema: 1
---

## 复现

Claude Code 2.1.283 使用内置参数和生产启动构造器：隔离配置下缺少 `--verbose`，退出码为 1；仅补该参数、保持 stdin 打开而不写入，12 秒无帧；关闭未写入的 stdin，退出码为 0 且无帧。普通 `assistant.message.content` 没有内容事件映射；回话服务向同一输入通道写裸文本。真实 `result` 已输出而 stdin 仍打开时，进程继续等待，关闭输入后退出。

## 返工任务

```task
stable-key: claude-stream-json-launch
title: Claude 原生启动、stdin 投递与普通消息帧接通生产运行链路
module: M4
source-tasks: M8-T10
depends-on: M4-T9, M6-T6, M8-T10, R8-T70356006
input: 内置 Claude 参数缺 verbose；前台 stream-json 输入忽略位置提示词，派发未写 stdin；普通 assistant 内容未映射，正常退出被 E-348 误判；回话发送裸文本且结果后输入不关闭。
output: 内置参数和启动构造器保证 verbose；初始提示词与运行中回话经适配器编码写入 stdin，结果到达后结束输入使进程退出；普通 assistant 文本、思考、工具内容映射为 ACP 事件；保留模型拒绝和零产出处理，提供真实脱敏录制与生产派发入口回归。
acceptance: 1) 隔离配置运行真实 Claude Code，记录版本；生产构造器生成的参数无需用户 verbose 设置即可执行并接收含换行和引号的提示词，stdin 只投递一次，运行期间可回话，结果后正常退出 2) 普通 assistant 帧的 text、thinking、tool_use 映射为对应事件，未知内容安全计数；真实失败 assistant 的错误正文不计为产出，保留 R8-T70356006 的主循环模型拒绝和子代理负例 3) dispatch.createRun→tick→生产 spawnManaged 的假子进程回放验证真实录制、提示词写入、日志和事件落盘；正常完成不进 E-348、零产出仍转人，stdin 失败可落定且回话失败不得报告成功 4) 厂商协议字段与编码仅由 adapters/claude 持有，所有运行阶段共用启动与 stdin 接线；保留环境清理、后台参数互斥和非 Claude 行为 5) pnpm -w check 全绿，任务笔记回填代码位置与实施沉淀，Jev 裁决记录包含真实 model 和 line；凭据不写仓库、日志或录制，脱敏保留 null。
edges: E-36, E-37, E-113, E-202, E-348
paths: packages/daemon/src/boot/container.ts, packages/daemon/src/adapters/claude/build-launch-spec.ts, packages/daemon/src/adapters/claude/map-events.ts, packages/daemon/src/adapters/claude/input.ts, packages/daemon/src/config/defaults.ts, packages/daemon/src/proc/spawn.ts, packages/daemon/src/service/message.ts, packages/daemon/test/unit/claude-adapter.test.ts, packages/daemon/test/unit/proc.test.ts, packages/daemon/test/unit/message-service.test.ts, packages/daemon/test/integration/dispatch-spawn.test.ts, packages/daemon/test/fixtures/dispatch/claude-2-1-283-success.stdout.ndjson, packages/daemon/test/fixtures/dispatch/claude-stream-json-recording.json
estimate: 1d
severity: S2
jev: model=jev-1.13.0 adjudicate pick=A(high 1.00) adopt=take(A); 保留 stream-json，适配器编码，通用启动器写入并按适配器完成信号结束 stdin。
```
