#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开发文档阅读器生成脚本（组件库 + 模型编排）

用法:
    python build_docs.py <文档目录>
    python build_docs.py <文档目录> --landed <任务ID> [<任务ID>…]
        记录落地：把 status: done 写进 图谱/任务/<ID>.md 的头部并重写 _run/progress.js，不重建阅读器
    python build_docs.py <文档目录> --batches
        重扫 _run/batches/*.md；普通记录只改 batchRecords，含返工 task 围栏时完整重建任务、契约、派发包与阅读器

产出（写在文档目录下）:
    index.html     阅读器 + 可视化组件库，跨项目复用
    docs-data.js   本项目的文档、结构化数据、编排方案

设计分层：
  * 可复用的是「呈现能力」——十一个可视化组件都在 index.html 里，不随项目变。
  * 随项目变的是「用哪些能力、怎么组织、重点标在哪」——由 _run/presentation.json
    声明，模型写。缺这个文件就退回默认编排（有数据的组件全上）。
  * 图表一律手写 SVG，不引 CDN。这份 HTML 要能拷进内网断网双击就看。

阅读器有三类视图：概览、任务交接台、24 节正文。**交接台是侧边栏里的独立一页**，
不埋在概览底部——派活是高频操作，翻到底再找它不合理。概览页仍留一张入口卡显示
派活进度，点它跳过去。

交接台把文档反过来编译成「任务提示词」：每个任务一键复制出三份可直接粘给模型的指令——
给写代码模型的实施指令、交活后给验收模型的审查指令、以及专门去找 bug 的查错指令
（顶部另有一份查全项目接缝的）。提示词是自包含的——任务卡全字段、依赖任务标题、
涉及的每条 E-XX 完整定义都内联进去，读提示词的模型不翻文档也能开工。提示词里的
项目侧信息（技术栈、仓库名、分支前缀、视觉方向）来自 presentation.json 的
handoff 段，缺了就退到通用默认值。

任务状态四格：待派 → 进行中 → 审查中 → 已落地。「实施」复制成功自动推到进行中，
「审查」复制成功自动推到审查中；「已落地」页面自己看不到 GitHub，由审查方落地时跑
`--landed` 记录：status 写进任务笔记头部（随那一层的提交进仓库，一任务一文件不冲突），
再从全部笔记派生出 _run/progress.js，阅读器加载时与本机点出来的进度合并、取更靠后的一格。
没记录就手点状态标签兜底。下游任务的「实施」在前置全部已落地之前是灰的；契约复核不锁「实施」，它在审查阶段登记，
锁「实施」的只有明确的契约错误、过期的结构检查和同步中的文档补丁。已落地任务被文档补丁标为待复验时显示
「已落地·待复验」，仍算已落地、不锁下游。落地记录随 docs-data.js 的 progress 进仓库，换检出目录只 git pull
也看得到；本机 _run/progress.js 只是覆盖。「查 bug」不改状态。
审查提示词把问题分成阻断与非阻断两级，只有阻断项才打回，且最多打回两轮，之后由审查方
自己修完落地——不给「审了又审」留路。
一批（按依赖层级算的「第 N 批」）全部落地后，批次标题右侧出现「批次收口」：复制一份把整批当整体做小结、
跑测试、查批内与跨批接缝的提示词，记录写进 _run/batches/batch-<N>-<日期>.md。普通记录随 docs-data.js 的 batchRecords
进仓库；open 记录里的 task 围栏会生成新的未落地返工任务（--batches 因此完整重建）。默认收口闸门锁紧邻下一批，handoff.wrapupGate=false 可关闭，复制不改状态。批次标题行可点折叠，默认只展开有在跑
或可派任务的批，手动开合记在本机。进行中与审查中的状态标签带一个呼吸圆点，一眼看出哪几行还在动。
每批的收口提示词也随 dispatch.json 与 docs-data.js 的 dispatchBatches 键导出，下游按 tasks 集合匹配本批。
查 bug 提示词也随 dispatch 导出（bug 键），一律按「代码还在栈分支」的未落地措辞生成：产品在任务落地前、
在该任务的工作树里派它运行；页面的「查 bug」按钮才看此刻状态，已落地的切成主干措辞。

交接台顶部是并行窗口调度：把未落地的任务排进 N 条 lane，一条 lane 就是一个会话
窗口。排的时候同时受依赖层级和 handoff.taskPaths 的文件冲突约束——依赖只保证逻辑
不撞，两个互不依赖的任务照样能抢同一个文件。

数据来源（靠表格解析，所以文档必须按约定用表格）：
    03 术语表      | 术语 | 含义 | 代码中对应 |
    06 架构        | M1 | 职责 | 依赖 |
    10 接口约定    | 方法 | 路径 | 入参 | 返回 | 权限 |
    13 边界        | E-01 | 场景 | 触发条件 | 期望行为 | 模块 |
    19 任务拆分    | M1-T1 | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |
    20 里程碑      | 第一批 | 模块 | 人天 | 结束时可演示 |
    21 风险        | 风险 | 影响 | 缓解动作 | 触发条件 |
    22 决策记录    | # | 问题 | 评审 | 选定 | 理由 | 边界编号 | 隐含假设 | 置信 |
    23 变更记录    | 版本 | 日期 | 变更内容 | 原因 | 涉及决策 |

22/23 两节喂的是「演进与决策」时间线：版本是主干节点，决策按 23 节末列的
序号挂到对应版本下（末列可选，不写就全挂首版）。被驳回的问题与低置信决策
在时间线上单独标色——那是交付后最该复核的两类。

文档里 ```mermaid 围栏内的 sequenceDiagram 与 stateDiagram 会被就地渲染成
SVG（自带极简解析器，不引 mermaid.js）。解析不了的原样显示成源码。

若存在 _run/review.json（review.py --json 产出），审查状态会显示在顶栏。
"""

import datetime
import hashlib
import json
import os
import re
import sys
import subprocess
from pathlib import Path
from handoff_contract import (analyze, digest, readiness, read_json, write_text, write_json,
                              source_version, manifest, stale_reasons, path_valid)

GROUP_ORDER = ["00-概览", "01-约束", "02-设计", "03-质量", "04-执行", "05-附录"]
FENCE = chr(96) * 3

HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>开发文档</title>
<script src="docs-data.js"></script>
<script src="_run/progress.js"></script>
<script src="_run/maintenance.js"></script>
<style>
:root{
  color-scheme: light;
  --paper:#FCFCFA; --panel:#F4F5F2; --ink:#14181D; --muted:#626C78;
  --rule:#E4E6E3; --rule-strong:#CFD3CE;
  --accent:#3A4E7A; --accent-soft:#EBEEF5; --accent-line:#8F9FC4;
  --pass:#1F7A5C; --fail:#A8321F; --warn:#8A5B00;
  --crit:#B4541F; --crit-soft:#FBEFE7;
  --sans:"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  --mono:"Cascadia Mono",Consolas,"SF Mono",ui-monospace,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.75;
  -webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}

.top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:16px;
  height:52px;padding:0 20px;background:var(--paper);border-bottom:1px solid var(--rule)}
.brand{display:flex;align-items:baseline;gap:10px;min-width:0}
.brand b{font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand span{font-size:12px;color:var(--muted);white-space:nowrap}
.top .spacer{flex:1}
.badge{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11.5px;
  padding:4px 9px;border:1px solid var(--rule-strong);border-radius:3px;color:var(--muted);white-space:nowrap}
.badge b{font-weight:600}
.badge.pass{color:var(--pass);border-color:#BFDDD0;background:#F2F9F6}
.badge.fail{color:var(--fail);border-color:#E8C4BD;background:#FDF4F2}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.tbtn{font-size:13px;color:var(--muted);padding:5px 10px;border:1px solid var(--rule);border-radius:3px;white-space:nowrap}
.tbtn:hover{color:var(--ink);border-color:var(--rule-strong)}
#menu{display:none}

.wrap{display:grid;grid-template-columns:266px minmax(0,1fr);align-items:start}
.side{position:sticky;top:52px;height:calc(100vh - 52px);overflow-y:auto;
  border-right:1px solid var(--rule);padding:16px 0 40px}
.search{padding:0 16px 14px}
.search input{width:100%;padding:7px 10px;font:inherit;font-size:13.5px;background:var(--panel);
  border:1px solid transparent;border-radius:4px;color:var(--ink)}
.search input:focus{background:var(--paper);border-color:var(--accent);outline:none}
.search input::placeholder{color:#9AA3AD}

.grp{margin:0 0 4px}
.grp>h4{margin:14px 0 6px;padding:0 16px;font-size:10.5px;font-weight:650;letter-spacing:.13em;
  color:#98A1AB;text-transform:uppercase}
.nav{display:flex;width:100%;gap:11px;padding:6px 16px;text-align:left;align-items:baseline;
  border-left:2px solid transparent;line-height:1.5}
.nav:hover{background:var(--panel)}
.nav .n{font-family:var(--mono);font-size:11px;color:#A2AAB4;flex:none;padding-top:1px}
.nav .t{font-size:13.5px;flex:1;min-width:0}
.nav .c{font-family:var(--mono);font-size:10.5px;color:#A2AAB4}
.nav.on{background:var(--accent-soft);border-left-color:var(--accent)}
.nav.on .t{font-weight:600;color:var(--accent)}
.nav.on .n{color:var(--accent)}
.nav.top-item{margin-bottom:6px;padding-top:8px;padding-bottom:8px}
.nav.top-item .t{font-weight:600}
/* 交接台入口的角标是实时进度，比章节里的条目计数更该被看见 */
.nav.top-item .c{color:var(--accent);font-weight:600;font-size:11px}
.nav.top-item .c.all{color:var(--pass)}
.navsep{margin:8px 16px 4px;border-top:1px solid var(--rule)}

.main{padding:40px 48px 120px;max-width:1180px;min-width:0}
.eyebrow{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:11.5px;
  color:var(--muted);margin-bottom:10px}
.eyebrow .num{color:var(--accent);font-weight:600}
.doc h1{font-size:28px;font-weight:650;letter-spacing:-.02em;margin:0 0 28px;line-height:1.3}
.doc h2{font-size:19px;font-weight:640;letter-spacing:-.01em;margin:34px 0 12px;
  padding-bottom:7px;border-bottom:1px solid var(--rule)}
.doc h3{font-size:15.5px;font-weight:640;margin:24px 0 8px}
.doc p{margin:0 0 14px}
.doc ul,.doc ol{margin:0 0 14px;padding-left:22px}
.doc li{margin:4px 0}
.doc blockquote{margin:0 0 14px;padding:2px 0 2px 16px;border-left:2px solid var(--rule-strong);color:var(--muted)}
.doc hr{border:none;border-top:1px solid var(--rule);margin:28px 0}
.doc code{font-family:var(--mono);font-size:.88em;background:var(--panel);padding:1.5px 5px;border-radius:3px}
.doc pre{background:var(--panel);border:1px solid var(--rule);border-radius:5px;padding:14px 16px;
  overflow-x:auto;margin:0 0 14px}
.doc pre code{background:none;padding:0;font-size:12.5px;line-height:1.65}
.tw{overflow-x:auto;margin:0 0 18px}
.doc table,.blk table{border-collapse:collapse;min-width:100%;margin:0;font-size:13.5px;line-height:1.6}
.doc th,.blk th{position:sticky;top:52px;background:var(--panel);text-align:left;font-weight:620;font-size:12.5px;
  padding:8px 11px;border-bottom:1px solid var(--rule-strong);white-space:nowrap;z-index:5}
/* 需要横向滚动的宽表：滚动容器会让 sticky 相对容器定位、盖住首行，所以改为静态表头 */
.tw.scroll th{position:static}
.doc th[data-sort]{cursor:pointer;user-select:none}
.doc th[data-sort]:hover{color:var(--accent)}
.doc th .ar{opacity:.35;font-size:9px;margin-left:4px}
.doc th.asc .ar,.doc th.desc .ar{opacity:1;color:var(--accent)}
.doc td,.blk td{padding:8px 11px;border-bottom:1px solid var(--rule);vertical-align:top}
.doc td:first-child{white-space:nowrap}
.doc td:last-child{white-space:nowrap}
.doc tbody tr:hover,.blk tbody tr:hover{background:#FAFAF8}

.chip{font-family:var(--mono);font-size:.85em;padding:1px 6px;border-radius:3px;
  background:var(--accent-soft);color:var(--accent);border:1px solid #DCE2EE;
  white-space:nowrap;transition:background .12s}
.chip:hover{background:#DFE5F1}
.card{position:absolute;z-index:60;width:340px;max-width:calc(100vw - 24px);background:var(--paper);
  border:1px solid var(--rule-strong);border-radius:6px;box-shadow:0 8px 28px rgba(20,24,29,.13);
  padding:13px 15px;font-size:13px;line-height:1.6}
.card[hidden]{display:none}
.card .cid{font-family:var(--mono);font-size:11.5px;color:var(--accent);font-weight:600;margin-bottom:7px}
.card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 12px}
.card dt{color:var(--muted);font-size:12px;white-space:nowrap}
.card dd{margin:0}
.card .miss{color:var(--muted)}

.hits{padding:0 16px}
.hit{display:block;width:100%;text-align:left;padding:9px 11px;margin-bottom:5px;
  border:1px solid var(--rule);border-radius:4px;line-height:1.55}
.hit:hover{border-color:var(--accent);background:var(--accent-soft)}
.hit b{display:block;font-size:12.5px;font-weight:600;margin-bottom:3px}
.hit span{font-size:11.5px;color:var(--muted);display:block;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.hit mark{background:#FDF0C8;color:inherit;padding:0 1px}
.none{padding:10px 16px;font-size:12.5px;color:var(--muted)}

.pager{display:flex;justify-content:space-between;gap:14px;margin-top:56px;
  padding-top:18px;border-top:1px solid var(--rule)}
.pager button{max-width:46%;text-align:left;font-size:13px;color:var(--muted);line-height:1.5}
.pager button:hover{color:var(--accent)}
.pager .k{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em}
.pager .r{text-align:right}

/* ── 概览页与组件 ───────────────────────── */
.lead{font-size:16.5px;line-height:1.8;margin:0 0 30px;padding:18px 22px;
  background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 5px 5px 0}
.blk{margin:0 0 42px}
.blk>h2{font-size:17px;font-weight:640;letter-spacing:-.01em;margin:0 0 4px;
  display:flex;align-items:baseline;gap:10px}
.blk>h2 .k{font-family:var(--mono);font-size:10.5px;color:#A2AAB4;font-weight:500;letter-spacing:.08em}
.blk>.note{font-size:13.5px;color:var(--muted);margin:0 0 14px;max-width:76ch}
.blk .pane{border:1px solid var(--rule);border-radius:6px;background:#FDFDFC;padding:18px;overflow-x:auto}

.mx{display:grid;grid-template-columns:repeat(auto-fit,minmax(122px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.mx div{background:var(--paper);padding:13px 15px}
.mx b{display:block;font-size:23px;font-weight:640;letter-spacing:-.02em;line-height:1.25}
.mx b.ok{color:var(--pass)} .mx b.bad{color:var(--fail)}
.mx span{font-size:11.5px;color:var(--muted)}

svg{display:block}
svg text{font-family:var(--sans)}
svg .id{font-family:var(--mono);font-size:10px;fill:var(--accent)}
svg .nm{font-size:11px;fill:var(--ink)}
svg .sub{font-size:9.5px;fill:var(--muted)}
svg .node{fill:var(--paper);stroke:var(--rule-strong);cursor:pointer}
svg .node:hover{stroke:var(--accent)}
svg .node.crit{fill:var(--crit-soft);stroke:var(--crit)}
svg .node.hi{stroke:var(--accent);stroke-width:2}
svg .lk{fill:none;stroke:var(--rule-strong);stroke-width:1.2}
svg .lk.crit{stroke:var(--crit);stroke-width:1.8}
svg .lane{font-size:10px;fill:var(--muted)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:12px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:5px;
  border:1px solid var(--rule-strong);background:var(--paper)}
.legend i.crit{background:var(--crit-soft);border-color:var(--crit)}

/* 覆盖矩阵是内容宽度表，必须写成 .blk table.emx——纯 .emx 的优先级压不过上面的
   .blk table，min-width:100% 会把它拉满、把空白全挤进首列 */
.blk table.emx{border-collapse:separate;border-spacing:0;font-size:11px;min-width:0;width:auto}
.emx th{position:static;background:none;padding:3px 4px;font-weight:500;white-space:nowrap;
  border:none;color:var(--muted);font-family:var(--mono);font-size:10px}
.emx th.rw{text-align:right;padding-right:9px}
.emx td{padding:0;border:none;width:26px;height:22px;text-align:center;vertical-align:middle}
.emx td i{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent)}
.emx tr.miss th.rw{color:var(--fail);font-weight:700}
.emx tr:hover td{background:var(--panel)}
.emx .cnt{font-family:var(--mono);font-size:10px;color:var(--muted);padding-left:9px;white-space:nowrap}

.lanes{display:flex;flex-direction:column;gap:10px}
.lane{display:grid;grid-template-columns:86px 1fr;gap:14px;align-items:start}
.lane .nm{font-weight:640;font-size:13.5px;padding-top:7px}
.lane .bar{border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:0 5px 5px 0;
  padding:9px 13px;background:#FDFDFC}
.lane .mods{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:5px;align-items:center}
.lane .d{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-left:auto}
.lane .demo{font-size:13px;color:var(--muted);line-height:1.6}

.risks{display:grid;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));gap:12px}
.risk{border:1px solid var(--rule);border-top:2px solid var(--warn);border-radius:5px;padding:13px 15px;background:#FDFDFC}
.risk b{display:block;font-size:13.5px;font-weight:640;margin-bottom:7px;line-height:1.5}
.risk dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12.5px;line-height:1.6}
.risk dt{color:var(--muted);white-space:nowrap}
.risk dd{margin:0}

.terms{display:grid;grid-template-columns:repeat(auto-fit,minmax(258px,1fr));gap:10px}
.term{border:1px solid var(--rule);border-radius:5px;padding:11px 14px;background:#FDFDFC}
.term b{font-size:13.5px;font-weight:640}
.term code{font-family:var(--mono);font-size:11px;color:var(--accent);background:var(--accent-soft);
  padding:1px 5px;border-radius:3px;margin-left:7px}
.term p{margin:5px 0 0;font-size:12.5px;color:var(--muted);line-height:1.6}

/* ── 任务交接台：把文档编译成可复制的任务提示词 ── */
.hand{border:1px solid var(--rule);border-radius:6px;background:#FDFDFC;overflow:hidden}
.hand .kick{display:flex;align-items:center;gap:15px;padding:14px 16px;
  background:var(--accent-soft);border-bottom:1px solid var(--rule)}
.hand .kick p{margin:0;flex:1;min-width:0;font-size:12.5px;color:var(--muted);line-height:1.65}
.hbatch>h5{margin:0;padding:8px 16px;font-family:var(--mono);font-size:10.5px;font-weight:600;
  letter-spacing:.05em;color:var(--muted);background:var(--panel);border-bottom:1px solid var(--rule);
  display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* 标题行本身是折叠开关；右侧的「批次收口」是按钮，点它不折叠 */
.hbatch>h5 .tg{flex:none;cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:6px}
.hbatch>h5 .tg:hover{color:var(--ink)}
.hbatch>h5 .tg .tri{font-family:var(--sans);font-size:9px;width:9px;display:inline-block;color:var(--muted)}
.hbatch>h5 .cnt{flex:none;font-weight:500;letter-spacing:0}
.hbatch>h5 .cp{margin-left:auto;font-weight:500;letter-spacing:0}
.cp.batch:hover{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.hbody[hidden]{display:none}
.htask{display:flex;align-items:center;gap:11px;padding:7px 16px;border-bottom:1px solid var(--rule)}
.hbatch:last-child .htask:last-child{border-bottom:none}
.htask:hover{background:#FAFAF8}
.htask .hid{flex:none;width:84px}
.htask .htt{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.htask .hd{flex:none;font-family:var(--mono);font-size:10.5px;color:var(--muted);width:34px;text-align:right}
.cp{flex:none;font-family:var(--mono);font-size:11px;padding:3px 9px;white-space:nowrap;
  color:var(--muted);border:1px solid var(--rule-strong);border-radius:3px;transition:all .12s}
.cp:hover{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.cp.done{color:var(--pass);border-color:#BFDDD0;background:#F2F9F6}
.cp.err{color:var(--fail);border-color:#E8C4BD;background:#FDF4F2}
.cp.bug:hover{color:var(--crit);border-color:#E9CDB8;background:var(--crit-soft)}
.cp.big{font-family:var(--sans);font-size:12.5px;font-weight:600;padding:6px 13px;
  color:var(--accent);border-color:var(--accent-line);background:var(--paper)}
.card .acts{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px;padding-top:10px;border-top:1px solid var(--rule)}

/* 派活进度与冲突标记。状态类只加在 .htask 上，别用 .blk——那个名字被概览页板块占了 */
.hnow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:11px 16px;background:#FDFDFC;border-bottom:1px solid var(--rule)}
.hnow .bar{flex:none;width:104px;height:5px;background:var(--rule);border-radius:3px;overflow:hidden}
.hnow .bar i{display:block;height:100%;background:var(--pass);transition:width .2s}
.hnow .txt{flex:1;min-width:0;font-size:12.5px;color:var(--muted);line-height:1.6}
.hnow .txt b{color:var(--ink);font-weight:640}
.hnow .txt em{font-style:normal;font-family:var(--mono);font-size:11.5px;color:var(--accent)}
.hnow .rs{flex:none;font-family:var(--mono);font-size:10.5px;color:var(--muted);
  border:1px solid var(--rule);border-radius:3px;padding:2px 8px}
.hnow .rs:hover{color:var(--fail);border-color:#E8C4BD}

.htask .st{flex:none;width:62px;padding:2px 0;font-family:var(--mono);font-size:10px;text-align:center;
  color:var(--muted);border:1px solid var(--rule-strong);border-radius:3px}
/* 呼吸点：在跑的两格各带一个圆点，扫一眼就知道哪几行还在动。宽度多留的 10px 就是给它的 */
.htask.doing .st::before,.htask.review .st::before{content:"";display:inline-block;width:6px;height:6px;
  border-radius:50%;margin-right:5px;vertical-align:1px;animation:hpulse 1.6s ease-in-out infinite}
.htask.doing .st::before{background:var(--warn)}
.htask.review .st::before{background:var(--accent)}
@keyframes hpulse{0%,100%{opacity:.35}50%{opacity:1}}
.htask .st:hover{color:var(--accent);border-color:var(--accent-line)}
.htask .st[disabled]{cursor:default}
.htask .st[disabled]:hover{color:var(--pass);border-color:#BFDDD0}
.htask.doing{background:#FFFCF4}
.htask.doing .st{color:var(--warn);background:#FCF6E8;border-color:#E5D3A6}
.htask.review{background:#F6F8FC}
.htask.review .st{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.htask.done{opacity:.48}
.htask.done .st{color:var(--pass);background:#F2F9F6;border-color:#BFDDD0}
.htask.done .htt{text-decoration:line-through;text-decoration-color:var(--rule-strong)}
/* 已落地·待复验：仍算已落地，但要被看见——不压暗、不划线，用警示色 */
.htask.recheck{background:var(--crit-soft)}
.htask.recheck .st{width:auto;padding:2px 6px;color:var(--crit);background:#FFF;border-color:#E3B894}
.htask.recheck .st[disabled]:hover{color:var(--crit);border-color:#E3B894}
.htask.now{box-shadow:inset 3px 0 0 var(--accent)}
.htask .cls{flex:none;max-width:170px;overflow:hidden;text-overflow:ellipsis;
  padding:1px 6px;font-family:var(--mono);font-size:10px;white-space:nowrap;cursor:help;
  color:var(--crit);background:var(--crit-soft);border:1px solid #E9CDB8;border-radius:3px}
.htask .wait{flex:none;font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.cp[disabled]{opacity:.32;cursor:not-allowed}
.cp[disabled]:hover{color:var(--muted);border-color:var(--rule-strong);background:none}

/* ── 交接台独立页 ──
   它是侧边栏里的一等视图，不再是概览页最底下那一块。派活是高频操作，
   翻到底才找得到不合理 */
.hpage .hhint{font-size:13.5px;color:var(--muted);margin:0 0 22px;max-width:78ch}
.blk>.sub{font-size:12.5px;color:var(--muted);margin:0 0 12px}

/* 概览页留下的入口卡：只报进度和「现在能开几个会话」，详情去交接台 */
.hentry{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:15px 18px;
  border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;
  background:var(--accent-soft)}
.hentry .txt{flex:1;min-width:200px;font-size:13px;color:var(--muted);line-height:1.65}
.hentry .txt b{color:var(--ink);font-weight:640}
.hentry .txt em{font-style:normal;font-family:var(--mono);font-size:11.5px;color:var(--accent)}
.hentry .bar{flex:none;width:104px;height:5px;background:var(--rule);border-radius:3px;overflow:hidden}
.hentry .bar i{display:block;height:100%;background:var(--pass)}

/* ── 并行窗口调度 ──
   类名一律 .swim 前缀：.lane / .lanes 被上面的里程碑组件占着，
   直接复用会串样式（那两个是 grid 布局，甘特要的是 SVG 容器） */
.swim{border:1px solid var(--rule);border-radius:6px;background:#FDFDFC}
.swimtop{display:flex;align-items:center;gap:14px;flex-wrap:wrap;
  padding:11px 16px;border-bottom:1px solid var(--rule)}
.swimtop .txt{flex:1;min-width:220px;font-size:12.5px;color:var(--muted);line-height:1.6}
.swimtop .txt b{color:var(--ink);font-weight:640}
.swimtop .txt em{font-style:normal;font-family:var(--mono);font-size:11.5px;color:var(--accent)}
.swimn{display:flex;align-items:center;gap:5px;flex:none;font-size:11.5px;color:var(--muted)}
.swimn .nb{font-family:var(--mono);font-size:11px;width:23px;height:23px;
  border:1px solid var(--rule-strong);border-radius:3px;color:var(--muted)}
.swimn .nb:hover{color:var(--accent);border-color:var(--accent-line)}
.swimn .nb.on{color:var(--paper);background:var(--accent);border-color:var(--accent)}
.swimbox{overflow-x:auto;padding:14px 16px}
.swimcp{display:flex;flex-direction:column;gap:1px;flex:none;padding:0 16px 13px}
.swimcp button{display:flex;align-items:baseline;gap:9px;text-align:left;padding:4px 7px;
  font-size:12px;color:var(--muted);border:1px solid transparent;border-radius:3px}
.swimcp button:hover{color:var(--accent);border-color:var(--rule);background:var(--accent-soft)}
.swimcp button .w{font-family:var(--mono);font-size:10.5px;flex:none;width:52px}
.swimcp button .s{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.swimcp button.done{color:var(--pass)}
svg .swlane{font-size:11px;fill:var(--ink);font-weight:600}
svg .swtick{font-family:var(--mono);font-size:9.5px;fill:#A2AAB4}
svg .swgrid{stroke:var(--rule);stroke-width:1}
svg .swbox{fill:var(--accent-soft);stroke:var(--accent-line);cursor:pointer}
svg .swbox:hover{fill:#DFE5F1}
svg .swbox.crit{fill:var(--crit-soft);stroke:var(--crit)}
svg .swbox.doing{fill:#FCF6E8;stroke:#E5D3A6}
svg .swbox.review{fill:#EEF2FA;stroke:var(--accent-line)}
svg .swid{font-family:var(--mono);font-size:10px;fill:var(--accent)}
svg .swbox.crit+.swid,svg .swid.crit{fill:var(--crit)}
svg .swtt{font-size:9.5px;fill:var(--muted)}
svg .swgap{fill:none;stroke:var(--crit);stroke-width:1.2;stroke-dasharray:2 2}

/* ── 演进与决策时间线 ──
   主干是版本，决策挂在版本下。被驳回的和低置信的必须一眼看见——
   那是交付后最该复核的两类，埋在表格里等于没写 */
.evo{border-left:2px solid var(--rule-strong);margin-left:7px;padding-left:0}
.evo .ver{position:relative;padding:0 0 6px 22px;margin-top:20px}
.evo .ver:first-child{margin-top:2px}
.evo .ver::before{content:"";position:absolute;left:-7px;top:5px;width:12px;height:12px;
  border-radius:50%;background:var(--accent);border:2px solid var(--paper)}
.evo .ver>h5{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 3px;font-size:14px;font-weight:650}
.evo .ver>h5 .vn{font-family:var(--mono);font-size:12px;color:var(--accent)}
.evo .ver>h5 .vd{font-family:var(--mono);font-size:10.5px;color:var(--muted);font-weight:500}
.evo .ver>p{margin:0 0 2px;font-size:13px;color:var(--muted);line-height:1.65}
.evo .ver>p .k{color:#98A1AB;font-size:11.5px;margin-right:5px}
.evo .decs{margin:9px 0 0;padding:0;list-style:none}
.evo .dec{position:relative;padding:7px 11px 7px 13px;margin-bottom:5px;font-size:13px;line-height:1.6;
  border:1px solid var(--rule);border-left:2px solid var(--rule-strong);border-radius:0 4px 4px 0;background:var(--paper)}
.evo .dec .dh{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.evo .dec .dn{font-family:var(--mono);font-size:10.5px;color:#A2AAB4;flex:none}
.evo .dec .dq{flex:1;min-width:0;font-weight:600}
.evo .dec .tag{font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:3px;
  border:1px solid var(--rule-strong);color:var(--muted);white-space:nowrap}
.evo .dec .pick{margin:3px 0 0;color:var(--muted)}
.evo .dec .pick b{color:var(--ink);font-weight:600}
.evo .dec .why{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
.evo .dec.flawed{border-left-color:var(--fail);background:#FDF9F8}
.evo .dec.flawed .tag.st{color:var(--fail);border-color:#E8C4BD;background:#FDF4F2}
.evo .dec.low{border-left-color:var(--warn)}
.evo .dec .tag.cf{color:var(--warn);border-color:#E5D3A6;background:#FCF6E8}
.evo .none{font-size:12.5px;color:var(--muted);padding:4px 0}

/* ── mermaid：时序图与状态机图就地渲染 ──
   .pane 的 overflow 管不到 md() 渲染出来的内容，图要自带滚动容器 */
.mmd{overflow-x:auto;margin:0 0 18px;padding:16px 18px;
  border:1px solid var(--rule);border-radius:6px;background:#FDFDFC}
.mmd+.mmdcap{margin:-12px 0 18px;font-size:11.5px;color:var(--muted)}
svg .mln{stroke:var(--rule-strong);stroke-width:1;stroke-dasharray:3 4}
svg .mact{fill:var(--panel);stroke:var(--rule-strong);cursor:pointer}
svg .mact:hover{stroke:var(--accent)}
svg .mact.hi{stroke:var(--accent);stroke-width:2}
svg .mnm{font-size:11px;fill:var(--ink);font-weight:600}
svg .mmsg{font-size:10.5px;fill:var(--ink)}
svg .marr{fill:none;stroke:var(--ink);stroke-width:1.2}
svg .marr.dash{stroke-dasharray:4 3}
svg .mhead{fill:var(--ink)}
svg .mgrp{fill:none;stroke:var(--accent-line);stroke-width:1}
svg .mgrp.alt{stroke:var(--crit)}
svg .mgtag{font-family:var(--mono);font-size:9.5px;fill:var(--paper)}
svg .mgtagbg{fill:var(--accent-line)}
svg .mgtagbg.alt{fill:var(--crit)}
svg .mgcond{font-size:10px;fill:var(--muted)}
svg .mnote{fill:#FDF6DE;stroke:#E5D3A6}
svg .mnotetx{font-size:10px;fill:#6A5A2E}
svg .mseq{font-family:var(--mono);font-size:9px;fill:var(--accent)}
svg .mstate{fill:var(--paper);stroke:var(--rule-strong);cursor:pointer}
svg .mstate:hover{stroke:var(--accent)}
svg .mstart{fill:var(--ink);stroke:none}
svg .mend{fill:var(--paper);stroke:var(--ink);stroke-width:1.5}
svg .medge{fill:none;stroke:var(--rule-strong);stroke-width:1.2}
svg .melbl{font-size:9.5px;fill:var(--muted)}
svg .melblbg{fill:#FDFDFC}

/* 搜索结果分组 */
.hgrp{margin-bottom:13px}
.hgrp>h6{display:flex;justify-content:space-between;margin:0 0 5px;padding:0 3px;
  font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.09em;color:#98A1AB}
.hit .k{font-family:var(--mono);font-size:10px;color:var(--accent);margin-right:6px}
.hits .more{padding:2px 11px 6px;font-size:11.5px;color:var(--muted)}
.hits .none{padding:10px 3px}

#printall{display:none}
@media print{
  .top,.side,.pager,.card{display:none!important}
  /* 提示词是给人复制的，纸上按不动；窗口数选择器和 lane 导出同理 */
  .cp,.swimn,.swimcp,.hentry .cp{display:none!important}
  .htask .st::before{display:none!important}
  .hbody[hidden]{display:block!important}
  .wrap{display:block}
  #app{display:none}
  #printall{display:block;padding:0}
  .doc{page-break-after:always}
  body{font-size:11pt}
  .doc th{position:static}
  .mmd,.swimbox{overflow:visible}
  .mmd{break-inside:avoid}
}
@media (max-width:900px){
  /* 必须是 minmax(0,1fr)，写 1fr 等于 minmax(auto,1fr)，宽 SVG 会把整页顶出横向滚动 */
  .wrap{grid-template-columns:minmax(0,1fr)}
  .side{position:fixed;top:52px;left:0;width:280px;background:var(--paper);z-index:20;
    transform:translateX(-100%);transition:transform .2s}
  body.nav-open .side{transform:none;box-shadow:0 0 40px rgba(20,24,29,.16)}
  #menu{display:block}
  .main{padding:28px 20px 90px}
  .lane{grid-template-columns:1fr;gap:5px}
  .hand .kick{flex-direction:column;align-items:stretch;gap:11px}
  .htask{flex-wrap:wrap;gap:8px}
  .htask .htt{flex-basis:100%;white-space:normal}
  .swimtop{flex-direction:column;align-items:stretch}
  .hentry{flex-direction:column;align-items:stretch}
  .hentry .bar{width:100%}
}
@media (max-width:640px){
  .brand span{display:none}
  #print{display:none}
  .badge{font-size:10.5px;padding:3px 7px}
  .top{gap:10px;padding:0 12px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.htask .st::before{animation:none}}
</style>
</head>
<body>
<header class="top">
  <button id="menu" class="tbtn" aria-label="目录">☰</button>
  <div class="brand"><b id="proj">开发文档</b><span id="gen"></span></div>
  <div class="spacer"></div>
  <span id="rev" class="badge"><i class="dot"></i><span>未审查</span></span>
  <button class="tbtn" id="print">打印全文</button>
</header>

<div class="wrap">
  <nav class="side" id="side">
    <div class="search"><input id="q" type="search" placeholder="搜任务 / 边界 / 接口 / 术语（按 /）" autocomplete="off"></div>
    <div id="tree"></div>
    <div id="hits" class="hits" hidden></div>
  </nav>
  <main class="main" id="app"></main>
</div>
<div id="printall"></div>
<div class="card" id="card" hidden></div>

<script>
(function(){
"use strict";
var D = window.DOCS || {project:"开发文档", groups:[], index:{edges:{},tasks:{}}, data:{}, pres:{}};
var DT = D.data || {}, PR = D.pres || {};
var docs = [];
D.groups.forEach(function(g){ g.docs.forEach(function(d){ d.group=g.name; docs.push(d); }); });

var esc = function(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); };
var cut = function(s, n){ s = String(s||""); return s.length > n ? s.slice(0, n-1) + "…" : s; };

/* ── 极简 markdown 渲染（不引外部库，保证离线可看） ── */
function inline(t){
  return esc(t)
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,'<a href="$2">$1</a>');
}
function cells(line){
  return line.trim().replace(/^\|/,"").replace(/\|$/,"").split("|").map(function(c){return c.trim();});
}
var FENCE = new RegExp("^" + String.fromCharCode(96,96,96));
var LANG = new RegExp("^" + String.fromCharCode(96,96,96) + "+\\s*([A-Za-z0-9_+-]*)");
function md(src){
  var L = String(src||"").split("\n"), o = [], i = 0;
  while(i < L.length){
    var s = L[i];
    if(FENCE.test(s)){
      var lang = ((s.match(LANG)||[])[1] || "").toLowerCase();
      var buf=[]; i++;
      while(i<L.length && !FENCE.test(L[i])){ buf.push(L[i]); i++; }
      i++;
      var raw = buf.join("\n");
      o.push(lang === "mermaid" ? mermaid(raw) : "<pre><code>"+esc(raw)+"</code></pre>");
      continue;
    }
    if(/^#{1,4}\s/.test(s)){
      var lv = s.match(/^#+/)[0].length;
      o.push("<h"+lv+">"+inline(s.replace(/^#+\s*/,""))+"</h"+lv+">"); i++; continue;
    }
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(s)){ o.push("<hr>"); i++; continue; }
    if(/^\s*\|/.test(s)){
      var rows=[];
      while(i<L.length && /^\s*\|/.test(L[i])){ rows.push(cells(L[i])); i++; }
      var sep = rows[1] && rows[1].every(function(c){ return /^:?-{2,}:?$/.test(c) || c===""; });
      var head = sep ? rows[0] : null, body = sep ? rows.slice(2) : rows;
      var h = '<div class="tw"><table>';
      if(head){
        h += "<thead><tr>" + head.map(function(c){
          return '<th data-sort>'+inline(c)+'<span class="ar">▲</span></th>'; }).join("") + "</tr></thead>";
      }
      h += "<tbody>" + body.map(function(r){
        return "<tr>" + r.map(function(c){ return "<td>"+inline(c)+"</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
      o.push(h); continue;
    }
    if(/^\s*>/.test(s)){
      var qq=[];
      while(i<L.length && /^\s*>/.test(L[i])){ qq.push(L[i].replace(/^\s*>\s?/,"")); i++; }
      o.push("<blockquote>"+md(qq.join("\n"))+"</blockquote>"); continue;
    }
    if(/^\s*([-*+]|\d+\.)\s/.test(s)){
      var ord = /^\s*\d+\./.test(s), items=[];
      while(i<L.length && /^\s*([-*+]|\d+\.)\s/.test(L[i])){
        items.push(inline(L[i].replace(/^\s*([-*+]|\d+\.)\s+/,""))); i++;
      }
      o.push("<"+(ord?"ol":"ul")+">"+items.map(function(t){return "<li>"+t+"</li>";}).join("")+"</"+(ord?"ol":"ul")+">");
      continue;
    }
    if(!s.trim()){ i++; continue; }
    var p=[];
    while(i<L.length && L[i].trim() && !FENCE.test(L[i]) &&
          !/^(#{1,4}\s|\s*\||\s*>|\s*([-*+]|\d+\.)\s)/.test(L[i])){ p.push(L[i]); i++; }
    o.push("<p>"+inline(p.join(" "))+"</p>");
  }
  return o.join("\n");
}

/* ══════════════════════════════════════════════════
   mermaid：时序图与状态机图就地渲染成 SVG

   不引 mermaid.js——那是 1MB 的依赖，会毁掉「拷进内网断网双击就看」这条底线。
   自带一个只认这两种图的极简解析器，覆盖文档里实际会写的语法；
   **认不出的一律原样退回源码显示**，不报错也不白屏。

   文档约定时序图的参与方用模块 ID（M2 而不是「订单服务」）、步骤上标边界编号，
   所以这两类在图里都挂 data-node，点了走和正文芯片同一条弹卡通路。
   ══════════════════════════════════════════════════ */
function textW(s, px){
  s = String(s||""); var w = 0;
  for(var i = 0; i < s.length; i++){
    var c = s.charCodeAt(i);
    /* CJK 与全角标点按整字宽算，西文按 .55——差一点没关系，
       宁可算宽一点留白，也不要算窄了让文字压到线上 */
    w += (c > 0x2E7F && c < 0xFF61) || c > 0xFFDF ? px : (c === 32 ? px*0.32 : px*0.56);
  }
  return w;
}

/* SVG 文本里的 E-XX / M#-T# 单独拆成可点 tspan。
   chipify 明确跳过 svg（走 DOM 替换会打乱 SVG 布局），所以这里得自己挂 */
var SVGID = /\b(E-\d{2,3}|M\d{1,2}-T\d{1,3}|R\d{1,3}-T\d{1,8})\b/g;
function svgTx(s){
  s = String(s==null?"":s);
  var out = "", last = 0, m;
  SVGID.lastIndex = 0;
  while((m = SVGID.exec(s))){
    if(m.index > last) out += "<tspan>" + esc(s.slice(last, m.index)) + "</tspan>";
    out += '<tspan class="mid" data-node="' + esc(m[0]) +
           '" style="fill:var(--accent);cursor:pointer">' + esc(m[0]) + "</tspan>";
    last = m.index + m[0].length;
  }
  if(last < s.length) out += "<tspan>" + esc(s.slice(last)) + "</tspan>";
  return out || esc(s);
}

function mermaid(src){
  var body = String(src||"");
  var head = "";
  body.split("\n").some(function(l){
    var t = l.trim();
    if(!t || t.indexOf("%%") === 0) return false;
    head = t; return true;
  });
  try {
    if(/^sequenceDiagram\b/.test(head)) return mmdSeq(body);
    if(/^stateDiagram(-v2)?\b/.test(head)) return mmdState(body);
  } catch(err){
    /* 解析器盖不住的写法就退回源码。图看不到总好过整节打不开 */
  }
  return "<pre><code>" + esc(body) + "</code></pre>";
}

/* ── 时序图 ── */
var SEQ_MSG = /^\s*([^:]+?)\s*(-{1,2})(>>|>|\)|x)\s*([^:]+?)\s*:\s*([\s\S]*)$/;
var SEQ_PART = /^\s*(participant|actor)\s+(.+)$/i;
var SEQ_NOTE = /^\s*note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i;
var SEQ_OPEN = /^\s*(alt|opt|loop|par|critical|break|rect)\b\s*(.*)$/i;
var SEQ_SEP  = /^\s*(else|and|option)\b\s*(.*)$/i;

function mmdSeq(src){
  var acts = [], byId = {}, els = [], stack = [], auto = false;
  function actor(id, name){
    id = String(id||"").trim().replace(/^[+-]/, "");
    if(!id) return null;
    if(!byId[id]){ byId[id] = {id: id, name: name || id, i: acts.length}; acts.push(byId[id]); }
    else if(name) byId[id].name = name;
    return byId[id];
  }
  src.split("\n").forEach(function(line){
    var t = line.trim();
    if(!t || t.indexOf("%%") === 0 || /^sequenceDiagram\b/.test(t)) return;
    if(/^autonumber\b/i.test(t)){ auto = true; return; }
    /* 激活条、分组框、样式指令直接跳过——不画它们不影响读图 */
    if(/^(activate|deactivate|box|link|links|style|classDef|class)\b/i.test(t)) return;
    var m;
    if((m = t.match(SEQ_PART))){
      var d = m[2].split(/\s+as\s+/i);
      actor(d[0], d[1] ? d[1].trim() : null);
      return;
    }
    if((m = t.match(SEQ_NOTE))){
      var who = m[2].split(",").map(function(x){ return actor(x); }).filter(Boolean);
      if(who.length) els.push({k:"note", pos:m[1].toLowerCase(), who:who, text:m[3].trim()});
      return;
    }
    if(/^end\b/i.test(t)){
      var op = stack.pop();
      if(op) els.push({k:"close", open:op});
      return;
    }
    if((m = t.match(SEQ_SEP))){
      els.push({k:"sep", label:(m[2]||"").trim(), word:m[1].toLowerCase()});
      return;
    }
    if((m = t.match(SEQ_OPEN))){
      var o = {k:"open", type:m[1].toLowerCase(), label:(m[2]||"").trim()};
      /* rect rgb(240,240,240) 这种背景框，标签是颜色值，没有阅读价值 */
      if(o.type === "rect") o.label = "";
      els.push(o); stack.push(o);
      return;
    }
    if((m = t.match(SEQ_MSG))){
      var a = actor(m[1]), b = actor(m[4]);
      if(!a || !b) return;
      els.push({k:"msg", a:a, b:b, dash:m[2].length === 2, head:m[3], text:m[5].trim()});
      return;
    }
  });
  if(!acts.length || !els.length) throw new Error("empty");
  while(stack.length){ els.push({k:"close", open:stack.pop()}); }

  /* 列间距：先按参与方名字宽度定底线，再让每条消息的文字都放得下。
     不做第二步，长消息会横穿到隔壁参与方头上 */
  var half = acts.map(function(a){ return Math.max(42, textW(a.name, 11)/2 + 13); });
  var gap = [];
  for(var i = 0; i < acts.length - 1; i++) gap.push(half[i] + half[i+1] + 26);
  els.forEach(function(e){
    if(e.k !== "msg" || e.a.i === e.b.i) return;
    var lo = Math.min(e.a.i, e.b.i), hi = Math.max(e.a.i, e.b.i);
    var need = textW(e.text, 10.5) + 30, cur = 0, k;
    for(k = lo; k < hi; k++) cur += gap[k];
    if(need > cur){
      var add = (need - cur) / (hi - lo);
      for(k = lo; k < hi; k++) gap[k] += add;
    }
  });
  var X = [], PAD = 14;
  acts.forEach(function(a, i){ X[i] = i ? X[i-1] + gap[i-1] : PAD + half[0]; });

  var HEAD = 28, ROW = 30, SELF = 44, GTOP = 23, GSEP = 21, GBOT = 11;
  var y = HEAD + 18, n = 0, depth = 0, maxDepth = 0;
  els.forEach(function(e){
    if(e.k === "msg"){
      e.y = y; e.n = ++n;
      y += (e.a.i === e.b.i) ? SELF : ROW;
    } else if(e.k === "open"){
      e.y0 = y; e.depth = depth++; maxDepth = Math.max(maxDepth, depth); y += GTOP;
    } else if(e.k === "sep"){
      e.y = y + 4; y += GSEP;
    } else if(e.k === "close"){
      depth--; e.open.y1 = y + GBOT - 6; y += GBOT;
    } else if(e.k === "note"){
      e.h = 24 + (e.text.length > 26 ? 12 : 0);
      /* 后面留够 16：下一条消息的文字画在它自己 y 上方 6px 处，
         只留 9 的话文字会贴到 Note 框底边上 */
      e.y = y; y += e.h + 16;
    }
  });
  var BOT = y + 6, H = BOT + HEAD + 6;
  var W = X[X.length-1] + half[half.length-1] + PAD + 16;

  var o = [];
  /* 块框先画，压在最底层。嵌套的往里缩，不然两层框会贴在一起看不出层次 */
  els.forEach(function(e){
    if(e.k !== "open" || e.y1 == null) return;
    var pad = 8 + (e.depth||0) * 7;
    var x0 = PAD - 6 + pad, x1 = W - PAD - 4 - pad;
    var alt = e.type === "alt" || e.type === "critical" || e.type === "break";
    o.push('<rect class="mgrp' + (alt ? " alt" : "") + '" x="'+x0+'" y="'+e.y0+
           '" width="'+(x1-x0)+'" height="'+(e.y1-e.y0)+'" rx="4"/>');
    if(e.type !== "rect"){
      var tw = textW(e.type, 9.5) + 11;
      o.push('<rect class="mgtagbg' + (alt ? " alt" : "") + '" x="'+x0+'" y="'+e.y0+
             '" width="'+tw+'" height="15" rx="3"/>' +
             '<text class="mgtag" x="'+(x0+5)+'" y="'+(e.y0+11)+'">'+esc(e.type)+"</text>");
      if(e.label)
        o.push('<text class="mgcond" x="'+(x0+tw+7)+'" y="'+(e.y0+11)+'">'+svgTx(e.label)+"</text>");
    }
  });
  els.forEach(function(e){
    if(e.k !== "sep") return;
    o.push('<text class="mgcond" x="'+(PAD+10)+'" y="'+e.y+'">'+
           esc(e.word)+(e.label ? " " : "")+svgTx(e.label)+"</text>");
  });

  /* 生命线 */
  acts.forEach(function(a, i){
    o.push('<line class="mln" x1="'+X[i]+'" y1="'+HEAD+'" x2="'+X[i]+'" y2="'+BOT+'"/>');
  });
  /* 参与方框：头尾各一个，图长了也不用回头找哪一列是谁 */
  acts.forEach(function(a, i){
    var w = half[i]*2 - 8, x0 = X[i] - w/2;
    var tag = D.index.modules && D.index.modules[a.id] ? ' data-node="'+esc(a.id)+'"' : "";
    [0, BOT + 6].forEach(function(yy){
      o.push("<g"+tag+">" +
        '<rect class="mact" x="'+x0+'" y="'+yy+'" width="'+w+'" height="26" rx="4"/>' +
        '<text class="mnm" x="'+X[i]+'" y="'+(yy+17)+'" text-anchor="middle">'+esc(a.name)+"</text></g>");
    });
  });

  els.forEach(function(e){
    if(e.k === "msg") o.push(seqArrow(e, X, auto));
    else if(e.k === "note") o.push(seqNote(e, X, half, W, PAD));
  });
  return '<div class="mmd"><svg width="'+Math.round(W)+'" height="'+Math.round(H)+
         '" viewBox="0 0 '+Math.round(W)+' '+Math.round(H)+'">'+o.join("")+"</svg></div>";
}

function seqArrow(e, X, auto){
  var x1 = X[e.a.i], x2 = X[e.b.i], y = e.y, dash = e.dash ? " dash" : "";
  var num = auto ? '<text class="mseq" x="'+(Math.min(x1,x2)+3)+'" y="'+(y-14)+'">'+e.n+"</text>" : "";
  if(e.a.i === e.b.i){
    /* 自消息：向右绕一圈回来。文字放在环右边，不然会盖住生命线 */
    var w = 32, yb = y + 26;
    return num +
      '<path class="marr'+dash+'" d="M'+x1+' '+y+'h'+w+'v'+(yb-y)+'h'+(-w)+'"/>' +
      seqHead(x1 + 9, x1, yb, e.head) +
      '<text class="mmsg" x="'+(x1+w+7)+'" y="'+(y+13)+'">'+svgTx(e.text)+"</text>";
  }
  var dir = x2 > x1 ? 1 : -1, tip = x2 - dir*5;
  return num +
    '<path class="marr'+dash+'" d="M'+x1+' '+y+'H'+tip+'"/>' +
    seqHead(tip, x2, y, e.head) +
    '<text class="mmsg" x="'+((x1+x2)/2)+'" y="'+(y-6)+'" text-anchor="middle">'+svgTx(e.text)+"</text>";
}

function seqHead(from, to, y, kind){
  var dir = to >= from ? 1 : -1, t = to - dir*1;
  if(kind === ">>")
    return '<polygon class="mhead" points="'+t+','+y+' '+(t-dir*8)+','+(y-3.6)+' '+(t-dir*8)+','+(y+3.6)+'"/>';
  if(kind === "x")
    return '<path class="marr" d="M'+(t-dir*6)+' '+(y-5)+'l'+(dir*6)+' 10M'+(t-dir*6)+' '+(y+5)+'l'+(dir*6)+' -10"/>';
  /* > 与 ) 都画开口箭头，) 是异步消息，画得更窄一点以示区别 */
  var len = kind === ")" ? 6 : 8, sp = kind === ")" ? 3 : 4;
  return '<path class="marr" d="M'+(t-dir*len)+' '+(y-sp)+'L'+t+' '+y+'L'+(t-dir*len)+' '+(y+sp)+'"/>';
}

function seqNote(e, X, half, W, PAD){
  var lo = e.who[0].i, hi = e.who[e.who.length-1].i;
  var x0, w, tw = textW(e.text, 10) + 22;
  if(e.pos === "over"){
    /* 跨多个参与方时按两端中点居中：文字比跨度宽的时候，
       从左端起画会让整个框往左偏出去 */
    w = hi > lo ? Math.max(tw, X[hi] - X[lo] + 40) : tw;
    x0 = (X[lo] + X[hi])/2 - w/2;
  } else if(e.pos === "left of"){
    w = tw; x0 = X[lo] - half[lo] - 8 - w;
  } else {
    w = tw; x0 = X[lo] + half[lo] + 8;
  }
  x0 = Math.max(2, Math.min(x0, W - w - 4));
  return '<rect class="mnote" x="'+x0+'" y="'+e.y+'" width="'+w+'" height="'+e.h+'" rx="3"/>' +
    '<text class="mnotetx" x="'+(x0+w/2)+'" y="'+(e.y+e.h/2+4)+'" text-anchor="middle">'+svgTx(e.text)+"</text>";
}

/* ── 状态机图 ── */
var ST_EDGE = /^\s*(\[\*\]|[^\s>-][^->]*?)\s*-{2,}>\s*([^\s:][^:]*?)\s*(?::\s*([\s\S]*))?$/;
var ST_DECL = /^\s*state\s+"([^"]+)"\s+as\s+(\S+)\s*$/i;

function mmdState(src){
  var nodes = [], byId = {}, edges = [], alias = {}, sIdx = 0, eIdx = 0;
  function node(raw){
    var id = String(raw||"").trim();
    if(!id) return null;
    if(id === "[*]") return null;                       /* 起止点单独造，见下 */
    id = id.replace(/\s*:\s*$/, "");
    if(!byId[id]){ byId[id] = {id:id, name: alias[id] || id, kind:"s"}; nodes.push(byId[id]); }
    return byId[id];
  }
  function terminal(kind){
    var id = kind === "start" ? "__s" + (++sIdx) : "__e" + (++eIdx);
    var n = {id:id, name:"", kind:kind};
    byId[id] = n; nodes.push(n); return n;
  }
  var lines = src.split("\n");
  lines.forEach(function(line){
    var m = line.match(ST_DECL);
    if(m) alias[m[2]] = m[1];
  });
  lines.forEach(function(line){
    var t = line.trim();
    if(!t || t.indexOf("%%") === 0 || /^stateDiagram(-v2)?\b/.test(t)) return;
    if(ST_DECL.test(t)) return;
    /* 复合状态的花括号、方向指令、note 都跳过——内部转移仍会按普通转移画出来 */
    if(/^(direction|note|end)\b/i.test(t) || t === "}" || /\{\s*$/.test(t)) return;
    var m = t.match(ST_EDGE);
    if(!m) return;
    var a = m[1].trim() === "[*]" ? terminal("start") : node(m[1]);
    var b = m[2].trim() === "[*]" ? terminal("end") : node(m[2]);
    if(a && b) edges.push({a:a.id, b:b.id, label:(m[3]||"").trim()});
  });
  if(!nodes.length || !edges.length) throw new Error("empty");

  var ids = nodes.map(function(n){ return n.id; });
  var preds = {};
  ids.forEach(function(i){ preds[i] = []; });
  edges.forEach(function(e){ if(preds[e.b].indexOf(e.a) < 0) preds[e.b].push(e.a); });
  var lv = layerOf(ids, function(id){ return preds[id]; });

  nodes.forEach(function(n){
    n.w = n.kind === "s" ? Math.max(64, textW(n.name, 11) + 26) : 22;
    n.h = n.kind === "s" ? 34 : 22;
    n.lay = lv[n.id] || 0;
  });
  /* 边标签太长就截断，完整文本进 <title>。不截的话「拒绝（E-04 非法，须驳回）」
     这种标签会一路横穿到下一个状态框底下，被它盖掉一半 */
  edges.forEach(function(e){
    e.full = e.label;
    if(e.label && textW(e.label, 9.5) > 118){
      var t = e.label;
      while(t.length > 1 && textW(t + "…", 9.5) > 118) t = t.slice(0, -1);
      e.label = t + "…";
    } else { e.full = null; }
  });
  var byLay = {}, maxRow = 0;
  nodes.forEach(function(n){ (byLay[n.lay] = byLay[n.lay] || []).push(n); });
  var layW = {}, keys = Object.keys(byLay).map(Number).sort(function(a,b){ return a-b; });
  keys.forEach(function(k){
    var w = 0;
    byLay[k].forEach(function(n){ w = Math.max(w, n.w); });
    layW[k] = w;
    maxRow = Math.max(maxRow, byLay[k].length);
  });
  /* 层间距要放得下从这一层出发的最宽标签，否则标签压在下一层的状态框上 */
  var need = {};
  edges.forEach(function(e){
    var a = byId[e.a];
    if(a && e.label) need[a.lay] = Math.max(need[a.lay] || 0, textW(e.label, 9.5) + 24);
  });
  /* 每层按「前驱在上一层的平均行号」排一次序（重心排序）。
     不排的话节点顺序就是声明顺序，两条线会毫无必要地交叉成 X */
  var rowOf = {};
  function bary(n){
    var ps = preds[n.id].map(function(p){ return rowOf[p]; })
                        .filter(function(x){ return x != null; });
    return ps.length ? ps.reduce(function(s, x){ return s + x; }, 0) / ps.length : 99;
  }
  keys.forEach(function(k, ki){
    if(ki > 0) byLay[k].sort(function(a, b){ return bary(a) - bary(b); });
    byLay[k].forEach(function(n, r){ rowOf[n.id] = r; });
  });
  var GX = 62, GY = 20, x = 10, gapOf = {};
  keys.forEach(function(k){ gapOf[k] = Math.max(GX, need[k] || 0); });
  /* 跨层边从上方拱、回边从下方绕，两头都要预留出画弧的地方，
     不留就会被 viewBox 裁掉半条线 */
  var hasSkip = false, hasBack = false;
  edges.forEach(function(e){
    var a = byId[e.a], b = byId[e.b];
    if(!a || !b) return;
    if(b.lay <= a.lay) hasBack = true;
    else if(b.lay - a.lay > 1) hasSkip = true;
  });
  var TOP = hasSkip ? 38 : 10;
  keys.forEach(function(k, ki){
    byLay[k].forEach(function(n, r){
      n.x = x + (layW[k] - n.w)/2;
      n.y = TOP + r * (46 + GY) + (46 - n.h)/2;
    });
    x += layW[k] + (ki < keys.length - 1 ? gapOf[k] : GX);
  });
  var W = x - GX + 20, H = TOP + maxRow * (46 + GY) - GY + (hasBack ? 46 : 20);

  var o = [], lbls = [];
  /* 标签位置去重：同一个状态的多条入边，标签中点几乎重合。
     叠在一起两条都读不出来，撞上就往上让一行 */
  function freeY(lx, ly, lw){
    for(var pass = 0; pass < 8; pass++){
      var hit = false;
      for(var i = 0; i < lbls.length; i++){
        var p = lbls[i];
        if(Math.abs(p.x - lx) < (p.w + lw)/2 && Math.abs(p.y - ly) < 14){ hit = true; break; }
      }
      if(!hit) break;
      ly -= 15;
    }
    lbls.push({x: lx, y: ly, w: lw});
    return ly;
  }
  edges.forEach(function(e){
    var a = byId[e.a], b = byId[e.b];
    if(!a || !b) return;
    var x1 = a.x + a.w, y1 = a.y + a.h/2, x2 = b.x, y2 = b.y + b.h/2, back = b.lay <= a.lay;
    var d, lx = (x1+x2)/2, ly;
    if(back){
      /* 回边从底下绕。不绕的话它会直接压在中间那排节点上 */
      var dip = Math.max(a.y + a.h, b.y + b.h) + 22;
      x1 = a.x + a.w/2; x2 = b.x + b.w/2;
      d = "M"+x1+" "+(a.y+a.h)+"C"+x1+" "+dip+","+x2+" "+dip+","+x2+" "+(b.y+b.h);
      lx = (x1+x2)/2; ly = dip - 1;
    } else if(b.lay - a.lay > 1){
      /* 跨层边：直着连过去会从中间那层的状态框上横穿过去，改成从上方拱过去 */
      var top = Math.min(a.y, b.y) - 20;
      d = "M"+x1+" "+y1+"C"+((x1+x2)/2)+" "+top+","+((x1+x2)/2)+" "+top+","+(x2-6)+" "+y2;
      ly = (y1 + top)/2 - 2;
    } else {
      var mx = (x1+x2)/2;
      d = "M"+x1+" "+y1+"C"+mx+" "+y1+","+mx+" "+y2+","+(x2-6)+" "+y2;
      ly = (y1+y2)/2 - 5;
    }
    o.push('<path class="medge" d="'+d+'"/>');
    if(!back)
      o.push('<polygon class="mhead" points="'+x2+','+y2+' '+(x2-8)+','+(y2-3.6)+' '+(x2-8)+','+(y2+3.6)+'"/>');
    if(e.label){
      var lw = textW(e.label, 9.5) + 8;
      ly = freeY(lx, ly, lw);
      o.push('<rect class="melblbg" x="'+(lx-lw/2)+'" y="'+(ly-10)+'" width="'+lw+'" height="13" rx="2"/>' +
             '<text class="melbl" x="'+lx+'" y="'+ly+'" text-anchor="middle">' +
             (e.full ? "<title>"+esc(e.full)+"</title>" : "") + svgTx(e.label) + "</text>");
    }
  });
  nodes.forEach(function(n){
    if(n.kind === "start"){
      o.push('<circle class="mstart" cx="'+(n.x+11)+'" cy="'+(n.y+11)+'" r="8"/>');
    } else if(n.kind === "end"){
      o.push('<circle class="mend" cx="'+(n.x+11)+'" cy="'+(n.y+11)+'" r="9"/>' +
             '<circle class="mstart" cx="'+(n.x+11)+'" cy="'+(n.y+11)+'" r="5"/>');
    } else {
      var tag = D.index.modules && D.index.modules[n.id] ? ' data-node="'+esc(n.id)+'"' : "";
      o.push("<g"+tag+'><rect class="mstate" x="'+n.x+'" y="'+n.y+'" width="'+n.w+
             '" height="'+n.h+'" rx="5"/>' +
             '<text class="mnm" x="'+(n.x+n.w/2)+'" y="'+(n.y+n.h/2+4)+
             '" text-anchor="middle">'+svgTx(n.name)+"</text></g>");
    }
  });
  return '<div class="mmd"><svg width="'+Math.round(W)+'" height="'+Math.round(H)+
         '" viewBox="0 0 '+Math.round(W)+' '+Math.round(H)+'">'+o.join("")+"</svg></div>";
}

/* ── ID 芯片：正文里的 E-01 / M1-T2 变成可点的定义入口 ── */
var IDRE = /\b(E-\d{2,3}|M\d{1,2}-T\d{1,3}|R\d{1,3}-T\d{1,8})\b/g;
function chipify(root){
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), hit=[], n;
  while((n = w.nextNode())){
    /* button 也要排除：芯片本身是 button，塞进另一个 button 里会让浏览器
       按嵌套按钮处理，整行布局散架（lane 导出那行就是这么炸的） */
    if(n.parentElement.closest("pre,code,.chip,th,svg,button")) continue;
    IDRE.lastIndex = 0;
    if(IDRE.test(n.nodeValue)) hit.push(n);
  }
  hit.forEach(function(node){
    var box = document.createElement("span");
    box.innerHTML = esc(node.nodeValue).replace(IDRE, function(m){
      return '<button class="chip" data-id="'+m+'">'+m+"</button>";
    });
    node.replaceWith.apply(node, Array.prototype.slice.call(box.childNodes));
  });
}
var card = document.getElementById("card");
function showCardAt(x, y, id){
  var e = (D.index.edges||{})[id], t = (D.index.tasks||{})[id],
      m = (D.index.modules||{})[id], h = '<div class="cid">'+id+"</div>";
  if(e){
    h += "<dl><dt>场景</dt><dd>"+esc(e.scene||"—")+"</dd>"+
         "<dt>触发</dt><dd>"+esc(e.trigger||"—")+"</dd>"+
         "<dt>期望</dt><dd>"+esc(e.expect||"—")+"</dd>"+
         "<dt>模块</dt><dd>"+esc(e.module||"—")+"</dd></dl>";
  } else if(t){
    h += "<dl><dt>任务</dt><dd>"+esc(t.title||"—")+"</dd>"+
         "<dt>依赖</dt><dd>"+esc(t.dep||"无")+"</dd>"+
         "<dt>验收</dt><dd>"+esc(t.accept||"—")+"</dd>"+
         "<dt>预估</dt><dd>"+esc(t.est||"—")+"</dd>"+
         "<dt>状态</dt><dd data-st>"+ST_TEXT[stOf(id)]+"</dd></dl>"+
         '<div class="acts">'+
         /* 卡片里的「实施」和交接台那一行一样受依赖闸门管——否则从正文芯片进来
            就能绕过闸门，把一个前置还没落地的任务推成进行中 */
         '<button class="cp" data-kind="impl" data-task="'+esc(id)+'"'+
           (implLocked(id) ? ' disabled title="' + esc(implLockTitle(id)).replace(/"/g, "&quot;") + '"' : '')+'>复制实施提示词</button>'+
         '<button class="cp" data-kind="review" data-task="'+esc(id)+'">复制审查提示词</button>'+
         '<button class="cp bug" data-kind="bug" data-task="'+esc(id)+'">复制查 bug 提示词</button></div>';
  } else if(m){
    /* 时序图和状态机图上的参与方按约定就是模块 ID，点了要能看到它是干什么的 */
    h += "<dl><dt>职责</dt><dd>"+esc(m.role||"—")+"</dd>"+
         "<dt>依赖</dt><dd>"+esc(m.dep||"无")+"</dd>"+
         "<dt>任务</dt><dd>"+((m.tasks||[]).join("、") || "—")+"</dd></dl>";
  } else {
    h += '<div class="miss">没找到这个编号的定义——可能是引用写错了，或它还没被定义。</div>';
  }
  card.innerHTML = h; card.dataset.id = id; card.hidden = false;
  card.style.top = (y + 7) + "px";
  card.style.left = Math.max(12, Math.min(x, window.innerWidth - 356)) + "px";
}
function showCard(el, id){
  var r = el.getBoundingClientRect();
  showCardAt(r.left + window.scrollX, r.bottom + window.scrollY, id);
}
document.addEventListener("click", function(ev){
  /* 复制按钮要排在最前：它可能长在卡片里，往下走会被当成「点了卡片外面」而关掉卡片 */
  var cp = ev.target.closest(".cp");
  if(cp && cp.dataset.kind){
    if(cp.disabled) { ev.stopPropagation(); return; }
    var kind = cp.dataset.kind, taskId = cp.dataset.task;
    var txt = promptFor(kind, taskId || cp.dataset.batch);
    if(txt) copyText(txt, cp, function(){
      /* 复制成功就是动作本身：「实施」把待派推到进行中，「审查」把进行中推到审查中。
         只往前推一格，且只从对应的前一格推——重复复制、乱序复制都不改状态，
         已落地的更不能被倒退。「查 bug」不是流程节点，不改状态。
         最后一格（已落地）页面推不动：它看不到 GitHub，merge 之后要人手点状态标签。 */
      if(!taskId) return;
      var st = stOf(taskId), to = null;
      if(kind === "impl" && st === "todo") to = "doing";
      if(kind === "review" && st === "doing") to = "review";
      if(!to) return;
      setSt(taskId, to);
      /* 刚派出去的任务所在批要看得见：记为展开（只增不减，不折叠别的批） */
      if(to === "doing") setBatchOpen(batchLayers().lv[taskId], true);
      refreshHand();
      /* 重画把这一行连按钮一起换掉了，「已复制」要补到新按钮上，否则看着像没复制成功 */
      flashBtn(document.querySelector('.htask[data-t="' + taskId + '"] .cp[data-kind="' + kind + '"]'), true);
      var dd = card.querySelector("[data-st]");
      if(!card.hidden && card.dataset.id === taskId && dd) dd.textContent = ST_TEXT[to];
    });
    ev.stopPropagation(); return;
  }
  var bt = ev.target.closest('[data-act="batchtoggle"]');
  if(bt){
    var hb = bt.closest(".hbatch"), body = hb && hb.querySelector(".hbody");
    if(body){
      var openNow = body.hidden;
      body.hidden = !openNow;
      hb.classList.toggle("open", openNow);
      var tri = bt.querySelector(".tri"); if(tri) tri.textContent = openNow ? "▾" : "▸";
      setBatchOpen(bt.dataset.batch, openNow);
    }
    ev.stopPropagation(); return;
  }
  if(ev.target.closest('[data-act="gohand"]')){
    open(-2); ev.stopPropagation(); return;
  }
  var ln = ev.target.closest('[data-act="lanes"]');
  if(ln){
    setLaneCount(+ln.dataset.n);
    var sw = document.getElementById("swimbox");
    if(sw){ sw.innerHTML = swimBody(); }
    ev.stopPropagation(); return;
  }
  var lc = ev.target.closest('[data-act="lanecopy"]');
  if(lc){
    copyText(laneSeqText(+lc.dataset.lane), lc.querySelector(".s") || lc);
    ev.stopPropagation(); return;
  }
  var st = ev.target.closest('[data-act="st"]');
  if(st){
    var row = st.closest(".htask");
    if(row){
      var id = row.dataset.t, cur = stOf(id);
      /* 从已落地退回待派会把依赖它的任务重新锁住，手一滑点到的代价太大，问一句 */
      if(cur !== "done" || confirm("把 " + id + " 从「已落地」退回「待派」？依赖它的任务会重新被锁住。只改本机记录，不动代码。")){
        setSt(id, ST_NEXT[cur]); refreshHand();
      }
    }
    ev.stopPropagation(); return;
  }
  if(ev.target.closest('[data-act="reset"]')){
    if(confirm("把本机点出来的状态全部清回「待派」？审查方记进任务笔记的「已落地」不受影响，也不动文档和代码。")){
      PG = {};
      try { localStorage.removeItem(PKEY); } catch(e){}
      refreshHand();
    }
    ev.stopPropagation(); return;
  }
  var c = ev.target.closest(".chip");
  if(c){ showCard(c, c.dataset.id); ev.stopPropagation(); return; }
  var g = ev.target.closest("[data-node]");
  if(g){ showCard(g, g.getAttribute("data-node")); ev.stopPropagation(); return; }
  if(!ev.target.closest(".card")) card.hidden = true;
});
document.addEventListener("keydown", function(e){
  if(e.key === "Escape"){
    /* 搜索框里有内容时，Esc 先清搜索——讲解途中最常用的一步 */
    if(document.activeElement === q && q.value){
      q.value = ""; hits.hidden = true; tree.hidden = false; return;
    }
    card.hidden = true; document.body.classList.remove("nav-open");
  }
  if(document.activeElement.tagName === "INPUT") return;
  if(e.key === "/"){ e.preventDefault(); q.focus(); }
  if((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey && !e.altKey){
    if(handBtn){ e.preventDefault(); open(-2); }
  }
});

/* ── 表格排序与宽表分流 ── */
function sortable(root){
  root.querySelectorAll(".doc table").forEach(function(tb){
    tb.querySelectorAll("th[data-sort]").forEach(function(th, idx){
      th.addEventListener("click", function(){
        var body = tb.tBodies[0], rows = Array.prototype.slice.call(body.rows);
        var dir = th.classList.contains("asc") ? -1 : 1;
        tb.querySelectorAll("th").forEach(function(o){ o.classList.remove("asc","desc"); });
        th.classList.add(dir === 1 ? "asc" : "desc");
        rows.sort(function(a,b){
          var x=(a.cells[idx]||{}).innerText||"", y=(b.cells[idx]||{}).innerText||"";
          var nx=parseFloat(x), ny=parseFloat(y);
          if(!isNaN(nx) && !isNaN(ny) && /^[\d.\s]+[dD天]?$/.test(x.trim())) return (nx-ny)*dir;
          return x.localeCompare(y,"zh")*dir;
        });
        rows.forEach(function(r){ body.appendChild(r); });
      });
    });
  });
}
function fitTables(root){
  root.querySelectorAll(".tw").forEach(function(w){
    var t = w.querySelector("table"); if(!t) return;
    w.classList.remove("scroll"); w.style.overflow = "";
    if(t.scrollWidth > w.clientWidth + 1) w.classList.add("scroll");
    else w.style.overflow = "visible";
  });
}

/* ══════════════════════════════════════════════════
   组件库：能力固定，内容全部来自本项目的文档数据
   ══════════════════════════════════════════════════ */
var HI = PR.highlights || {};
function isHi(kind, id){ return (HI[kind]||[]).indexOf(id) >= 0; }

/* 关键路径：按人天加权的最长链 */
function critical(tasks){
  var by = {}, best = {}, from = {};
  tasks.forEach(function(t){ by[t.id] = t; });
  function w(id, stack){
    if(best[id] != null) return best[id];
    if(stack.indexOf(id) >= 0) return 0;
    var t = by[id], m = 0, f = null;
    (t.deps||[]).forEach(function(p){
      if(by[p]){ var v = w(p, stack.concat([id])); if(v > m){ m = v; f = p; } }
    });
    from[id] = f; best[id] = m + (t.est||0);
    return best[id];
  }
  tasks.forEach(function(t){ w(t.id, []); });
  var end = null, mx = -1;
  tasks.forEach(function(t){ if(best[t.id] > mx){ mx = best[t.id]; end = t.id; } });
  var path = [], cur = end;
  while(cur){ path.unshift(cur); cur = from[cur]; }
  return {path: path, total: mx};
}

function svgNodes(items, opt){
  /* items: [{id, line1, line2, layer, deps}] → 分层布局的 SVG */
  var W = opt.w, H = opt.h, gx = 56, gy = 14;
  var byLayer = {}, maxRow = 0;
  items.forEach(function(it){
    (byLayer[it.layer] = byLayer[it.layer] || []).push(it);
  });
  Object.keys(byLayer).forEach(function(k){
    byLayer[k].sort(function(a,b){ return a.id.localeCompare(b.id); });
    byLayer[k].forEach(function(it, r){ it.x = it.layer*(W+gx); it.y = r*(H+gy); });
    maxRow = Math.max(maxRow, byLayer[k].length);
  });
  var pos = {}; items.forEach(function(it){ pos[it.id] = it; });
  var nLayer = Object.keys(byLayer).length;
  var sw = nLayer*(W+gx) - gx + 4, sh = maxRow*(H+gy) - gy + 4;

  var links = [];
  items.forEach(function(it){
    (it.deps||[]).forEach(function(p){
      var a = pos[p]; if(!a) return;
      var x1 = a.x+W, y1 = a.y+H/2, x2 = it.x, y2 = it.y+H/2, mx = (x1+x2)/2;
      var crit = opt.crit && opt.crit.indexOf(p) >= 0 && opt.crit.indexOf(it.id) >= 0 &&
                 Math.abs(opt.crit.indexOf(p) - opt.crit.indexOf(it.id)) === 1;
      links.push('<path class="lk'+(crit?" crit":"")+'" d="M'+x1+' '+y1+'C'+mx+' '+y1+','+mx+' '+y2+','+(x2-5)+' '+y2+'"/>' +
                 '<circle cx="'+(x2-3)+'" cy="'+y2+'" r="2.2" fill="'+(crit?"var(--crit)":"var(--rule-strong)")+'"/>');
    });
  });

  var nodes = items.map(function(it){
    var cls = "node" + (opt.crit && opt.crit.indexOf(it.id) >= 0 ? " crit" : "") +
              (isHi(opt.hiKind, it.id) ? " hi" : "");
    return '<g data-node="'+esc(it.id)+'">' +
      '<rect class="'+cls+'" x="'+it.x+'" y="'+it.y+'" width="'+W+'" height="'+H+'" rx="5"/>' +
      '<text class="id" x="'+(it.x+10)+'" y="'+(it.y+15)+'">'+esc(it.id)+'</text>' +
      '<text class="nm" x="'+(it.x+10)+'" y="'+(it.y+30)+'">'+esc(it.line1)+'</text>' +
      (it.line2 ? '<text class="sub" x="'+(it.x+W-10)+'" y="'+(it.y+15)+'" text-anchor="end">'+esc(it.line2)+'</text>' : '') +
      '</g>';
  });
  return '<svg width="'+sw+'" height="'+sh+'" viewBox="-2 -2 '+sw+' '+sh+'">' +
         links.join("") + nodes.join("") + '</svg>';
}

var C = {};

/* ══════════════════════════════════════════════════
   任务提示词：把文档反编译成能直接派活的指令
   实施提示词给写代码的模型，审查提示词给验收的模型。
   自包含——任务卡、依赖标题、边界定义全内联，不指望对方去翻文档。
   ══════════════════════════════════════════════════ */
var HO = PR.handoff || {};
var HC = D.handoff || {contracts:{}, readiness:{}, effectivePaths:{}};
var MAINT = window.MAINTENANCE || {pendingTasks:[], needsReview:[]};
/* 契约「待语义复核」是审查阶段要登记的一步，不锁派发；contractPending 只用来数「已复核 N/M」。
   真正锁「实施」的是 contractBlocked：契约有明确错误（H01–H11）、结构检查过期、或本任务的
   文档补丁还在同步——这三种情况说明任务要求本身还不可信 */
function contractPending(id){
  var r = HC.readiness && HC.readiness[id];
  return !r || !r.ready || (MAINT.pendingTasks || []).indexOf(id) >= 0;
}
function contractBlocked(id){
  var r = HC.readiness && HC.readiness[id];
  return !r || (r.blockers || []).length > 0 || (MAINT.pendingTasks || []).indexOf(id) >= 0;
}
var HDOCS  = HO.docsPath || ("docs/" + D.project + "-开发文档");
var HREPO  = HO.repo || "repo";
var HPRE   = HO.branchPrefix || "task/";
var HMAIN  = HO.mainBranch || "main";
function hBranch(id){ return HPRE + id; }
function hTree(w){ return "../" + HREPO + "-w" + w; }

function findBy(list, id){
  var a = (list||[]).filter(function(x){ return x.id === id; });
  return a.length ? a[0] : null;
}
function taskById(id){ return findBy(DT.tasks, id); }

/* 按依赖算层级：层号 = 最长前驱链长度。有环则就地截断，不死循环。
   放在 core 里是因为导出器也要按批分组；前面 mermaid 布局的调用靠函数声明提升 */
function layerOf(ids, depsOf){
  var lv = {};
  function walk(id, stack){
    if(lv[id] != null) return lv[id];
    if(stack.indexOf(id) >= 0) return 0;
    var m = 0;
    depsOf(id).forEach(function(p){
      if(ids.indexOf(p) >= 0) m = Math.max(m, walk(p, stack.concat([id])) + 1);
    });
    lv[id] = m; return m;
  }
  ids.forEach(function(id){ walk(id, []); });
  return lv;
}
/* 交接台的「第 N 批」：lv 是任务 → 0 起层号，by[k] 是该层任务（按 ID 排序）。
   Python 端 task_layers 用同一算法，--landed 才能报「哪批已全部落地」 */
function batchLayers(){
  var tasks = (DT.tasks || []).filter(function(t){ return !t.repair; });
  var lv = layerOf(tasks.map(function(t){ return t.id; }), function(id){
    var t = taskById(id); return (t && t.deps) || [];
  });
  var by = {};
  tasks.forEach(function(t){ (by[lv[t.id]] = by[lv[t.id]] || []).push(t); });
  Object.keys(by).forEach(function(k){
    by[k].sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  });
  return {lv: lv, by: by};
}

/* ── 派活进度：状态存本机浏览器，用来算「此刻能并发派哪几个」 ── */
var PKEY = "unattended-run/" + (D.project || "docs") + "/progress";
var PG = {};
try { PG = JSON.parse(localStorage.getItem(PKEY) || "{}") || {}; } catch(e){ PG = {}; }
/* 四格。进行中 → 审查中这一格是给「审查」按钮推的：没有它，「在审」和「在写」
   分不开，用户看不出该催谁。已落地那一格页面自己看不到 GitHub，两条路：
   审查方落地时跑 build_docs.py --landed，把 status 写进任务笔记并生成 _run/progress.js，
   页面加载时读它；没跑就手点状态标签。两边取更靠后的一格 */
var ST_NEXT = {todo:"doing", doing:"review", review:"done", done:"todo"};
var ST_TEXT = {todo:"待派", doing:"进行中", review:"审查中", done:"已落地", recheck:"已落地·待复验"};
var ST_RANK = {todo:0, doing:1, review:2, done:3};
/* 落地记录随 docs-data.js 进仓库（D.progress），本机 _run/progress.js 只是覆盖：换检出目录只 git pull 也看得到已落地 */
var FP = Object.assign({}, D.progress || {}, window.PROGRESS || {});
/* 批次收口记录随 docs-data.js 进仓库（--batches 重扫 _run/batches/*.md）。
   匹配只看任务集合，不看批次号：任务表一改，层号会漂，集合不会 */
var BR = D.batchRecords || {};
function fileSt(id){ return ST_RANK[FP[id]] != null ? FP[id] : "todo"; }
function fileLanded(id){ return fileSt(id) === "done"; }
/* 维护标记影响闸门，但不把尚未实施或已有落地历史的任务变成开放代码 PR。 */
function progressOf(id){
  var a = PG[id] || "todo", b = fileSt(id);
  return ST_RANK[b] > ST_RANK[a] ? b : a;
}
function landedNeedsReview(id){
  return fileLanded(id) && (MAINT.needsReview || []).indexOf(id) >= 0;
}
/* 已落地又被文档补丁标为待复验的是第五种显示态 recheck：它仍算已落地（不锁下游、不占窗口），
   只是提醒去做复验。把它显示成「审查中」曾让全部下游被静默锁死两天 */
function stOf(id){
  if((MAINT.pendingTasks || []).indexOf(id) >= 0) return "review";
  if(landedNeedsReview(id)) return "recheck";
  if((MAINT.needsReview || []).indexOf(id) >= 0 || FP[id] === "review") return "review";
  return progressOf(id);
}
function isLanded(id){ var s = stOf(id); return s === "done" || s === "recheck"; }
function setSt(id, v){
  if(v === "todo") delete PG[id]; else PG[id] = v;
  try { localStorage.setItem(PKEY, JSON.stringify(PG)); } catch(e){}
}
/* 批次折叠：只记用户点过的批（{k: true|false}），没点过的按默认规则算 */
var BKEY = "unattended-run/" + (D.project || "docs") + "/batches-open";
function batchOpenMap(){
  try { return JSON.parse(localStorage.getItem(BKEY) || "{}") || {}; } catch(e){ return {}; }
}
function setBatchOpen(k, v){
  if(k == null) return;
  var m = batchOpenMap(); m[String(k)] = !!v;
  try { localStorage.setItem(BKEY, JSON.stringify(m)); } catch(e){}
}

/* ── 路径冲突：依赖层级只保证逻辑不冲突，两个任务照样能抢同一个文件 ── */
var TP = HC.effectivePaths || HO.taskPaths || {};
function pathsOf(id){ return TP[id] || []; }
/* p 是否落在 w 之内。按路径段比，别让 model/order 匹配上 model/orderitem */
function under(p, w){
  if(p === w) return true;
  var q = w.charAt(w.length - 1) === "/" ? w : w + "/";
  return p.indexOf(q) === 0;
}
function clashOf(a, b){
  var A = pathsOf(a), B = pathsOf(b);
  for(var i = 0; i < A.length; i++){
    for(var j = 0; j < B.length; j++){
      if(under(A[i], B[j])) return B[j];
      if(under(B[j], A[i])) return A[i];
    }
  }
  return null;
}
/* 与本任务抢文件的其他任务 */
function rivalsOf(id){
  return (DT.tasks||[]).filter(function(x){ return x.id !== id && clashOf(id, x.id); });
}

/* ── 该调哪些技能：按任务特征算，一条一行——时机、拿到什么、不调会漏什么 ── */
function isFrontend(mod){ return (HO.frontendModules||[]).indexOf(mod) >= 0; }
/* 谁依赖我。没有下游就是栈顶，合它就是整栈落地 */
function dependentsOf(id){
  return (DT.tasks||[]).filter(function(x){ return (x.deps||[]).indexOf(id) >= 0; });
}
/* side 取 "impl" 或 "review"。每条 [名字, 时机, 一句话：拿到什么 / 不调漏什么]。
   判准不抄进来，技能自己是正本；只在判 doc-issue 才用的两个写在那个分支处 */
function skillsFor(t, side){
  var S = [], fe = isFrontend(t.module);
  if(side === "impl"){
    S.push(["gh-stack", "切层、push 时", "每条命令的非交互标志；不带 --json/--auto 会卡死在全屏 TUI 且不报错"]);
    S.push(["dsh-prose-standard", "写实施沉淀时", "先枚举命题再删、全部存活才算改进；不调会写成一句正确的废话"]);
    S.push(["dsh-trim-cot-leakage", "沉淀写完后", "清掉「本来想…后来改成」这类只有在场者才解析得了的话"]);
    if(fe) S.push(["finesse-ui", "写组件与样式时", "把既定 token 落成组件、覆盖八态与手机档；register 与方向已定死，不重判、不重定、不出预览页"]);
    if(fe) S.push(["record-browser-gif", "交审查前", "从真实服务录 GIF，等待条件用 DOM 状态不用固定延时；没有 GIF 的界面任务多半被打回"]);
    S.push(["dsh-pre-push-checks", "推送前", "按本层 diff 挑最小充分测试集跑一遍；不许 --passWithNoTests、不许裸 --force"]);
    if(hasJudgments(t)) S.push(["typesafe-ai", "写判断层时", "先读 live docs 的 API/SDK 页与最近的 cookbook；一题一判断、criteria 带兜底、独立问题一次送、概率与 confidence 分开用；问题与阈值常量只放注册表文件，密钥只从服务端配置读"]);
  }else{
    S.push(["dsh-code-review", "打完勾之后", "接口两侧契约、生命周期与并发、绕过校验的入口、测试是否只把实现重写一遍；不调会放过「每条都做了但合起来是错的」"]);
    if(fe) S.push(["finesse-ui", "看 GIF 之前", "audit 只读命令：组件八态、对比度与焦点顺序、偷懒默认、手机六类硬伤"]);
    if(fe) S.push(["record-browser-gif", "要验收证据时", "GIF 必须来自真实服务与真实轮次，不许 fixture 或 mock"]);
    if(hasJudgments(t)) S.push(["typesafe-ai", "核判断层时", "对照 10 节语义判断契约核问题 ID、原语、criteria 兜底与阈值来源；一次真实调用记录的 model 字段才是证据，录制应答不算；TYPESAFE_API_KEY 未设置不判 pass"]);
    S.push(["dsh-prose-standard", "核回填时", "原有命题有没有被删掉"]);
    S.push(["dsh-trim-cot-leakage", "核回填时", "8 类会话残渣要清，9 类不算残渣要留"]);
    S.push(["dsh-pre-push-checks", "落地前", "按 outgoing diff 挑最小充分证据集；不许 --passWithNoTests、不许裸 --force"]);
    var up = dependentsOf(t.id);
    S.push(["dsh-merging-stacked-prs", "合并时", "先认单 PR 情形：GraphQL stack 为空、base 是主干、没人叠在上面 → 普通 gh pr merge；否则核栈成员与顺序、每层 open 且非 draft。两种都要等 MERGED、零依赖才删分支。" +
      (up.length ? "依赖本层的有 " + up.map(function(x){ return x.id; }).join("、") +
                   "：合本层 PR 会连同下层一起合；已叠在上面的层由 GitHub 改 base，让它们跑 gh stack sync"
                 : "本层是栈顶，合它就是整栈落地")]);
    S.push(["dsh-find-simplifications", "闻到重复时", "先按生产 / 非生产 / 模糊分清消费者再提案，不就地乱改"]);
  }
  /* 推断不到的情况留个逃生口：编排里点名的追加在后面 */
  ((HO.taskSkills || {})[t.id] || []).forEach(function(x){
    if(typeof x === "string") S.push([x, "本项目点名", ""]);
    else if(x && x.name)      S.push([x.name, x.when || "本项目点名", x.why || ""]);
  });
  return S;
}
function skillBlock(t, side){
  var S = skillsFor(t, side);
  if(!S.length) return "";
  var L = ["", "## 要用的技能（时机 — 拿到什么）"];
  S.forEach(function(x){ L.push("- `" + x[0] + "`　" + x[1] + (x[2] ? " — " + x[2] : "")); });
  return L.join("\n");
}

function waitingOn(t){
  return (t.deps||[]).filter(function(d){ return !isLanded(d); });
}
/* 一次跳过只绑定当前 open 记录；重收口出现新记录后自动恢复闸门。批次号按界面的一基编号填写。 */
function wrapupGateSkipped(k, rec){
  var skips = HO.wrapupGateSkipRecords;
  if(!skips || typeof skips !== "object" || Array.isArray(skips) || !rec || rec.verdict !== "open") return false;
  var source = skips[String(k + 1)];
  return typeof source === "string" && Object.prototype.hasOwnProperty.call(BR, source) && BR[source] === rec;
}
function wrapupBlocked(id){
  if(HO.wrapupGate === false) return null;
  var k = batchLayers().lv[id];
  if(!(k > 0) || !batchComplete(k - 1)) return null;
  var rec = batchRecord(k - 1);
  return !rec || (rec.verdict === "open" && !wrapupGateSkipped(k - 1, rec))
    ? {batch: k, verdict: rec ? rec.verdict : null} : null;
}
function implLockTitle(id){
  var block = wrapupBlocked(id);
  if(block) return "第 " + block.batch + " 批已全部落地但" +
    (block.verdict === "open" ? "收口有遗留" : "尚未收口") +
    '：先点该批标题右侧「批次收口」；定点跳过可在 handoff.wrapupGateSkipRecords 绑定当前记录，"wrapupGate": false 会关闭全部批次闸门';
  return "前置未落地、文档补丁同步中或任务要求有明确错误；点「审查」看原因";
}
function wrapupNotice(){
  var unwrapped = Object.keys(batchLayers().by).map(Number).filter(function(k){
    var rec = batchRecord(k);
    return batchComplete(k) && (!rec || (HO.wrapupGate !== false && rec.verdict === "open"));
  }).sort(function(a, b){ return a - b; });
  if(!unwrapped.length) return "";
  var open = unwrapped.some(function(k){ var rec = batchRecord(k); return rec && rec.verdict === "open"; });
  var legacy = unwrapped.some(function(k){ var rec = batchRecord(k); return rec && rec.repairWarning; });
  var skipped = unwrapped.filter(function(k){ return wrapupGateSkipped(k, batchRecord(k)); });
  var locked = (DT.tasks || []).some(function(t){ return stOf(t.id) === "todo" && !!wrapupBlocked(t.id); });
  return "　<b>" + unwrapped.length + "</b> 批已全部落地、尚未收口" + (open ? "或收口有遗留" : "") +
    "：第 " + unwrapped.map(function(k){ return k + 1; }).join("、") + " 批，点该批标题右侧「批次收口」。" +
    (legacy ? "<b>旧版 open 记录没有自动生成返工任务，重收口并补返工任务清单。</b>" : "") +
    (skipped.length ? "第 " + skipped.map(function(k){ return k + 1; }).join("、") + " 批闸门已跳过，返工任务仍待处理。" : "") +
    (HO.wrapupGate !== false && locked ? "<b>下一批的实施因此上锁</b>（仅紧邻下一批，不追溯更早批次）。" : "");
}
/* 实施按钮的闸门：本任务还是待派、前置全部已落地、契约没有明确错误；紧邻上一批落齐时须收口通过。行里和弹卡里共用这一个判断。
   同批次里别的任务在跑不算前置，不锁；契约待复核也不锁——那一步在审查提示词里做；前置已落地·待复验也不锁 */
function implLocked(id){ var t = taskById(id); return !t || stOf(id) !== "todo" || contractBlocked(id) || !!waitingOn(t).length || !!wrapupBlocked(id); }
/* 此刻能同时派出去的一组：依赖已落地、自己还没派、彼此之间以及与在跑的都不抢文件 */
function dispatchable(){
  var tasks = DT.tasks || [];
  var busy = tasks.filter(function(x){ return stOf(x.id) === "doing" || stOf(x.id) === "review"; });
  var out = [];
  tasks.forEach(function(t){
    if(stOf(t.id) !== "todo" || implLocked(t.id)) return;
    for(var i = 0; i < busy.length; i++) if(clashOf(t.id, busy[i].id)) return;
    for(var j = 0; j < out.length; j++) if(clashOf(t.id, out[j].id)) return;
    out.push(t);
  });
  return out;
}

/* ══════════════════════════════════════════════════
   并行窗口调度：把没落地的任务排进 N 条 lane，一条 lane 就是一个会话窗口。
   dispatchable() 只回答「这几个现在能并行」，回答不了「窗口 1 按什么顺序做、
   几天做完」——那是这里的事。约束两条，缺一不可：
     依赖层级   逻辑上谁必须等谁
     taskPaths  物理上谁和谁会改同一个文件（依赖图完全看不见这层）
   ══════════════════════════════════════════════════ */
var LKEY = "unattended-run/" + (D.project || "docs") + "/lanes";
/* 默认开几个窗口：逐个加 lane 试算，加到「再加一个也压不动工期」为止。
   不用「此刻能派几个」当默认——那个数被文件冲突压得很低（两个任务都动
   db/migrations/ 就只剩一个），会让人误以为这项目只值得开一个窗口 */
function bestLanes(){
  var best = 1, prev = null;
  for(var n = 1; n <= 4; n++){
    var s = planLanes(n).span;
    if(prev == null){ prev = s; continue; }
    if(s < prev * 0.88){ prev = s; best = n; } else break;
  }
  return best;
}
function laneCount(){
  var n = 0;
  try { n = parseInt(localStorage.getItem(LKEY), 10) || 0; } catch(e){ n = 0; }
  if(n >= 1 && n <= 6) return n;
  return Math.max(1, Math.min(4, bestLanes()));
}
function setLaneCount(n){ try { localStorage.setItem(LKEY, String(n)); } catch(e){} }

/* 每个任务往后还剩多长的链（含自己）。排程优先级用它：
   压在关键路径上的先占窗口，否则短任务先跑会把长链推到最后，整体工期变长 */
function tailLen(){
  var tasks = DT.tasks || [], by = {}, kids = {}, memo = {};
  tasks.forEach(function(t){ by[t.id] = t; kids[t.id] = []; });
  tasks.forEach(function(t){
    (t.deps||[]).forEach(function(p){ if(kids[p]) kids[p].push(t.id); });
  });
  function walk(id, stack){
    if(memo[id] != null) return memo[id];
    if(stack.indexOf(id) >= 0) return 0;
    var m = 0;
    kids[id].forEach(function(c){ m = Math.max(m, walk(c, stack.concat([id]))); });
    memo[id] = m + ((by[id] && by[id].est) || 0);
    return memo[id];
  }
  tasks.forEach(function(t){ walk(t.id, []); });
  return memo;
}

function planLanes(N){
  var tasks = DT.tasks || [], by = {};
  tasks.forEach(function(t){ by[t.id] = t; });
  var tail = tailLen();
  /* 已落地的当作 0 时刻就完成了——调度表要回答的是「剩下的怎么排」，
     不是「从头再来一遍怎么排」 */
  var finish = {}, merged = [];
  tasks.forEach(function(t){
    if(isLanded(t.id)){ finish[t.id] = 0; merged.push(t.id); }
  });
  var rest = tasks.filter(function(t){ return !isLanded(t.id); });

  var lanes = [], free = [];
  for(var i = 0; i < N; i++){ lanes.push([]); free.push(0); }
  var placed = [], guard = 0;

  while(rest.length && guard++ < 4000){
    var ready = rest.filter(function(t){
      return (t.deps||[]).every(function(d){ return !by[d] || finish[d] != null; });
    });
    if(!ready.length) break;              /* 依赖成环，剩下的单独报出去 */
    ready.sort(function(a, b){
      return (tail[b.id]||0) - (tail[a.id]||0) ||
             (b.est||0) - (a.est||0) || a.id.localeCompare(b.id);
    });
    var t = ready[0], est = t.est || 0.5;

    var dep0 = 0, depFrom = null;
    (t.deps||[]).forEach(function(d){
      if(finish[d] > dep0){ dep0 = finish[d]; depFrom = d; }
    });

    var best = null;
    for(var l = 0; l < N; l++){
      var s = Math.max(free[l], dep0), why = (s > free[l]) ? "dep" : "";
      /* 抢同一批文件的两个任务，执行区间不能重叠——工作树隔离的是工作目录，
         不是同一个文件的两处改动。撞上就往后推到对方做完 */
      for(var pass = 0; pass < 40; pass++){
        var moved = false;
        for(var k = 0; k < placed.length; k++){
          var p = placed[k];
          if(clashOf(t.id, p.id) && s < p.end && p.start < s + est){
            s = p.end; why = "clash:" + p.id; moved = true;
          }
        }
        if(!moved) break;
      }
      if(!best || s < best.s){ best = {l: l, s: s, why: why}; }
    }

    var rec = {id: t.id, task: t, lane: best.l, start: best.s, end: best.s + est,
               wait: best.why, depFrom: depFrom, st: stOf(t.id)};
    placed.push(rec); lanes[best.l].push(rec);
    free[best.l] = rec.end; finish[t.id] = rec.end;
    rest = rest.filter(function(x){ return x.id !== t.id; });
  }

  var span = 0;
  free.forEach(function(f){ span = Math.max(span, f); });
  /* 串行工期 = 所有还没落地的任务人天之和，用来对比出并行省了多少 */
  var serial = tasks.filter(function(t){ return !isLanded(t.id); })
    .reduce(function(s, x){ return s + (x.est||0); }, 0);
  return {lanes: lanes, placed: placed, blocked: rest, merged: merged,
          span: Math.round(span*10)/10, serial: Math.round(serial*10)/10};
}


/* 验收标准在文档里是「1) … 2) …」挤在一格，拆回逐条。
   编号只认行首或空白之后的——否则「（E-04）」里的「4）」会被当成条目编号，
   把边界编号从中间劈开，读提示词的一方就看不到该处理哪条边界了。
   做法是先在合格的编号前插一个换行，再统一按换行与分号切。 */
function acceptLines(s){
  var t = String(s||"").replace(/<br\s*\/?>/gi, "\n")
    .replace(/(^|[\s;；])\s*([1-9][)）、])/g, "$1\n$2");
  var parts = t.split(/[\n;；]/)
    .map(function(x){ return (x||"").trim(); })
    .filter(function(x){ return x.length > 2; });
  return parts.length ? parts : [String(s||"").trim() || "（文档里没写验收标准，实现前先补上）"];
}

function edgeBlock(ids){
  if(!ids || !ids.length)
    return "（验收标准没挂边界编号。仍按常识处理空输入、失败路径、重复提交。）";
  return ids.map(function(id){
    var e = findBy(DT.edges, id);
    if(!e) return "- " + id + "（文档里没找到定义，动手前先确认）";
    return "- " + id + "　" + (e.scene||"") + "\n  触发：" + (e.trigger||"—") + "　期望：" + (e.expect||"—");
  }).join("\n");
}

/* 视觉方向只发给前端模块的任务——后端任务里塞色板是噪音 */
function designBlock(mod){
  var d = HO.design;
  if(!d || !isFrontend(mod)) return "";
  var L = ["", "## 视觉方向（已定，照它实现，不自由发挥）"];
  if(d.register)  L.push("- **register：" + d.register + "**（前提，别重判）");
  if(d.dials)     L.push("- 三档刻度：" + (typeof d.dials === "object" && !Array.isArray(d.dials)
    ? Object.keys(d.dials).map(function(k){ return k + "=" + d.dials[k]; }).join(" / ") : d.dials));
  if(d.tone)      L.push("- 基调：" + d.tone);
  if(d.palette)   L.push("- 色板：" + d.palette);
  if(d.type)      L.push("- 字体：" + d.type);
  if(d.layout)    L.push("- 布局：" + d.layout);
  if(d.signature) L.push("- 标志性元素：" + d.signature);
  if(d.avoid)     L.push("- 要避开：" + d.avoid);
  if(d.tokens){
    L.push("");
    L.push("token 直接用，不自己编颜色、字号、圆角：");
    L.push("```css");
    L.push(String(d.tokens).replace(/^\n+|\n+$/g, ""));
    L.push("```");
  }
  if(d.components){ L.push(""); L.push("组件规范：" + String(d.components)); }
  L.push("");
  L.push("完整说明在 11 节「视觉方向」。查组件写法调 finesse-ui，但不许它重判 register、重定方向、不出预览页——直接在产品代码里把 token 落成组件。未定的 UI/UX 取舍写成 2–5 个选项，交 Jev 的 design 模板裁决，不交用户选择。");
  return L.join("\n");
}

/* 所有任务角色共享同一裁决协议；Jev 只选有限选项，任务方负责陈述事实与执行结果。 */
function jevAdjudication(label){
  return ["## 自行裁决：交 Jev，不交用户",
    "实施、审查、查 bug、批次收口过程中出现的每一条「自行裁决」，以及验收冲突、文档缺口、栈外依赖、UI/UX 未定项，都先列出 2–5 个真实可行的选项；不能把你想要的答案当唯一候选。",
    "把原始需求、任务标题与验收、冲突和选项忠实译成英文写入 state.json（文档与回报仍用中文）；UI/UX 取舍使用 design，其余使用 adjudicate。",
    "运行 python \"" + HDOCS + "/_run/typesafe_ask.py\" --log \"" + HDOCS + "/_run/judgments.jsonl\" --label \"" + label + "\" run adjudicate --state <state.json>；UI/UX 将 adjudicate 换成 design。若 language_warning 提示中文过多，重译后重跑。",
    "仅 status=ok 且 verdicts.adopt.action=take 才按 option 执行；confidence=low 仍用 Jev 的 option，记低置信风险。spec_change=yes 走文档补丁，outside_stack=yes 在回报点名，不自动扩权。",
    "adopt=red_line 仅涉及付费、不可逆删除、改变已定范围或对外承诺时请求用户授权；status=skipped/error 或缺有效 pick 时留下待 Jev 裁决，不得由人代答、判 pass、声称已落地或写 clean/fixed。",
    "回报逐条写：冲突 → 全部候选 → Jev line/model/采纳的 option → 代码或文档动作；没有写「无」。"] .join("\n");
}

/* 三段结构的字段名 → 提示词里的中文标签。顺序就是出现顺序：先定死放哪，再是每天都要碰的，最后是收尾的。
   没在表里的字段名原样当标签输出，自定义字段不会被吞掉 */
var ARCH_LABEL = {
  errors: "错误体系", env: "环境变量", naming: "命名与格式", types: "共享类型",
  layout: "目录结构", layers: "分层与调用方向",
  ui: "组件库", state: "状态管理", route: "路由", tier: "组件分层",
  api: "API 客户端层", data: "数据层", middleware: "中间件链", tx: "事务边界",
  utils: "工具层", config: "配置装载", di: "依赖注入",
  build: "构建产物", jobs: "后台任务", judgments: "语义判断层"
};
var ARCH_ORDER = ["layout", "layers", "tier", "ui", "route", "state", "api", "data",
                  "middleware", "tx", "utils", "errors", "env", "config", "di",
                  "build", "jobs", "judgments"];

/* 字符串形式原样输出（旧配置兼容），对象形式按 ARCH_ORDER 一项一行 */
function archLines(seg){
  if(!seg) return [];
  if(typeof seg === "string"){
    var s = String(seg).replace(/^\n+|\n+$/g, "");
    return s ? [s] : [];
  }
  var keys = ARCH_ORDER.filter(function(k){ return seg[k]; })
    .concat(Object.keys(seg).filter(function(k){
      return seg[k] && ARCH_ORDER.indexOf(k) < 0;
    }));
  return keys.map(function(k){
    return "- " + (ARCH_LABEL[k] || k) + "：" + String(seg[k]).replace(/\s*\n\s*/g, " ");
  });
}

/* shared 两边都发（错误码、环境变量这几条只发一侧另一侧迟早写出第二套），
   frontend / backend 按模块分发 */

function taskArch(mod, t){
  var a = HO.architecture || {}, own = isFrontend(mod) ? a.frontend : a.backend;
  var ctx = t && (HC.contracts[t.id] || {}).context || {};
  var keys = (ctx.definition || {}).archKeys;
  if(!Array.isArray(keys)){
    keys = null;
    Object.keys(HO.architectureScope || {}).forEach(function(prefix){
      var scoped = HO.architectureScope[prefix];
      if(t && Array.isArray(scoped) && pathsOf(t.id).some(function(p){ return under(p, prefix); })){
        keys = (keys || []).concat(scoped);
      }
    });
  }
  var selected = {}, omitted = [];
  if(keys === null || !own || typeof own === "string") return {own: own, omitted: omitted};
  Object.keys(own).forEach(function(k){
    if(keys.indexOf(k) >= 0) selected[k] = own[k];
    else if(own[k]) omitted.push(ARCH_LABEL[k] || k);
  });
  return {own: selected, omitted: omitted};
}
function appendixBlock(t){
  var arch = archBlock(t.module, t), design = designBlock(t.module);
  var omitted = taskArch(t.module, t).omitted;
  if(!arch && !design && !omitted.length) return "";
  var L = ["", "## 附录：约定与架构（先做完上面的再看这里；只列与本任务相关的条款，完整版见 06/07/08/11 节）"];
  if(arch) L.push(arch);
  if(design) L.push(design);
  if(omitted.length) L.push("", "未列出的条款：" + omitted.join("、") + "，见 " + (isFrontend(t.module) ? "07" : "08") + " 节");
  return L.join("\n");
}

function archBlock(mod, t){
  var a = HO.architecture;
  if(!a) return "";
  var fe = isFrontend(mod);
  var sh = archLines(a.shared), own = archLines(taskArch(mod, t).own);
  if(!sh.length && !own.length) return "";
  var L = [];
  if(sh.length){
    L.push(""); L.push("## 全项目共用约定（前后端必须一致；出处 06 节，要改回文档改）");
    L = L.concat(sh);
  }
  if(own.length){
    L.push(""); L.push("## 框架架构（已定，照它组织代码；完整说明见 " + (fe ? "07-前端架构" : "08-后端架构") + "）");
    L = L.concat(own);
  }
  return L.join("\n");
}

/* 角色段划的是权限边界：实施侧压住「顺手重构」，审查侧把「守没守住架构」列进职责 */
function roleBlock(t, side){
  var fe = isFrontend(t.module), has = !!HO.architecture;
  var who = has ? (fe ? "前端" : "后端") : "", sec = fe ? "07 节" : "08 节";
  var L = ["", "## 你的角色"];
  if(side === "impl"){
    L.push("本项目的" + who + "开发工程师。" +
           (has ? "架构在 " + sec + " 与 06 节共用约定里已定死（下面有摘要）；" : "约定以开发文档为准；") +
           "你的活是在既定约定内实现这一个任务，不重新设计、不顺手重构。" +
           "被架构约定挡住（照约定做不到、只能违反 06/08 节才能完成）也不自行停下或绕过去另起一套：列出候选交 Jev，按 spec_change 标记走文档补丁，并写进回报——下一个任务不知道，第三个又会起第三套。" +
           "工具报错、仓库现状与本提示词对不上这类事，「步骤」里都写了怎么办：照做并记进回报，不停下来问。");
  }else{
    L.push("本项目的" + who + "架构师。除了功能做没做，还要审这一层守没守住" +
           (has ? " " + sec + " 与 06 节的约定" : "架构一致性") + "：" +
           (fe ? "组件放对层没有、有没有绕过 API 客户端层直接发请求、有没有硬编码本该走环境变量或错误码枚举的值、组件库是直接引原始组件还是走了二次封装。"
               : "有没有跨层调用或反向依赖、事务是不是开在约定的那一层、有没有硬编码本该走环境变量的值、错误有没有走统一错误体系。") +
           "这类问题验收标准查不出来。");
  }
  return L.join("\n");
}

/* 提示词里的 git 命令是给人直接粘去执行的，标题里的双引号会把 -m "" 撑破。
   名字不能叫 q——「导航与渲染」段的 var q 是搜索框，会把同名函数覆盖掉 */
function shq(s){ return String(s||"").replace(/"/g, "'"); }

function promptHead(t){
  var m = findBy(DT.modules, t.module);
  var L = ["## 项目"];
  L.push("- 项目：" + D.project + (HO.stack ? "　｜　技术栈：" + HO.stack : ""));
  L.push("- 开发文档：" + HDOCS + "（知识库入口 " + HDOCS + "/_MOC.md）");
  L.push("");
  L.push("## 本任务");
  L.push("- 模块：" + t.module + (m ? "　" + m.role : ""));
  L.push("- 输入：" + (t.input || "无"));
  L.push("- 产出：" + (t.output || "见验收标准"));
  L.push("- 预估：" + (t.est ? t.est + " 人天" : "—") + "　｜　前置：" +
         ((t.deps||[]).length
           ? t.deps.map(function(d){ var x = taskById(d); return d + (x ? "　" + x.title : ""); }).join("；") + "（已落地）"
           : "无"));
  return L.join("\n");
}

/* 知识库必读清单：路径写死成具体文件，比一句「去看知识库」有效得多 */
function vaultRefs(t){
  var V = HDOCS + "/图谱/";
  var L = ["## 动手前先读（知识库，顺 [[链接]] 取，不整本读）"];
  L.push("- " + V + "任务/" + t.id + ".md　任务卡 + 前人留下的实施沉淀");
  L.push("- " + V + "模块/" + t.module + ".md　模块职责与已有代码位置");
  if((t.edges||[]).length)
    L.push("- " + V + "边界/ 下的 " + t.edges.map(function(e){ return e + ".md"; }).join("、") + "　本任务要兜的边界");
  return L.join("\n");
}


function wiringFor(t){
  var ctx = (HC.contracts[t.id] || {}).context || {};
  var own = ctx.wiring, registry = HO.wiring || {}, out = {};
  function files(value){ return typeof value === "string" ? [value] : (Array.isArray(value) ? value : []); }
  Object.keys(own || registry).forEach(function(k){
    var ps = files(own ? own[k] : registry[k]);
    if(own && !ps.length) ps = files(registry[k]);
    if(!own) ps = ps.filter(function(p){
      return pathsOf(t.id).some(function(scope){ return under(p, scope); });
    });
    ps = ps.filter(function(p, i){ return p && ps.indexOf(p) === i; });
    if(ps.length) out[k] = ps;
  });
  return out;
}
function wiringBlock(t){
  var wiring = wiringFor(t), keys = Object.keys(wiring);
  if(!keys.length) return "";
  var criteria = {
    backendRoutes: "路由已注册并返回真实数据", frontendRoutes: "页面已挂进装配件可导航",
    container: "service 已注册并被路由或 job 调用", eventKinds: "事件从产生到订阅端到端",
    buildPipeline: "构建产物在浏览器里样式已加载",
    judgments: "问题与阈值常量集中于此、与 10 节语义判断契约同 ID、一次真实调用记录了 model"
  };
  return ["", "## 接线要求（做完必须从入口可达）"].concat(keys.map(function(k){
    return "- " + k + "：" + wiring[k].join("、") + "；" + (criteria[k] || "已登记且被消费");
  })).join("\n");
}
/* 判断层任务：有效范围覆盖了 wiring.judgments 登记的文件，或契约里点名了该类别 */
function hasJudgments(t){ return !!wiringFor(t).judgments; }
function depCodeBlock(t){
  var L = [];
  (t.deps || []).forEach(function(id){
    var dep = taskById(id);
    if(!dep || !(dep.codeRefs || []).length) return;
    L.push("", "### " + id + " " + dep.title);
    L = L.concat(dep.codeRefs);
  });
  return L.length ? ["", "## 前置留下的代码位置（直接用，不重造）"].concat(L).join("\n") : "";
}
function refsBlock(t){
  var source = [t.title, t.output, t.accept, t.input].join("\n");
  var tokenPattern = /\/api\/[\w/:.-]+|\bE_[A-Z0-9_]+\b|\b[a-z]+\.[a-z_]+\b/g;
  function tokens(s){ return String(s || "").match(tokenPattern) || []; }
  var entitySource = source.replace(tokenPattern, " ");
  var wanted = tokens(source), rows = [];
  function add(raw){
    String(raw || "").split("\n").forEach(function(row){
      if(row.trim() && rows.indexOf(row) < 0) rows.push(row);
    });
  }
  (DT.endpoints || []).forEach(function(e){
    var fields = e.fieldContracts || [], raw = [e.raw || ""].concat(fields).join("\n");
    if(tokens([e.path, raw].join("\n")).some(function(token){ return wanted.indexOf(token) >= 0; })){
      add(e.raw); fields.forEach(add);
    }
  });
  (DT.entities || []).forEach(function(e){
    var name = String(e.name || "").replace(/^[`*]+|[`*]+$/g, "").trim();
    if(!name) return;
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if(new RegExp("(^|[^A-Za-z0-9_])" + escaped + "(?=$|[^A-Za-z0-9_])").test(entitySource)) add(e.raw);
  });
  if(!rows.length) return "";
  var L = ["", "## 相关契约（照它实现，改要走文档补丁）"].concat(rows.slice(0, 30));
  if(rows.length > 30) L.push("…还有 " + (rows.length - 30) + " 条，见 10/09 节");
  return L.join("\n");
}

/* 保留逐字正文；围栏内的 ## 是示例内容，不另算一段。长度按 Unicode 字符，与 Python len 一致。 */
function promptSections(text){
  var sections = [], name = "头部", lines = [], fence = null;
  String(text).split("\n").forEach(function(line){
    var mark = line.match(/^\s*(`{3,}|~{3,})/), heading = !fence && line.match(/^## (.+)$/);
    if(heading){
      if(lines.length) sections.push([name, lines.join("\n")]);
      name = heading[1]; lines = [];
    }
    lines.push(line);
    if(mark){
      if(!fence) fence = mark[1];
      else if(mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
    }
  });
  if(lines.length) sections.push([name, lines.join("\n")]);
  return sections;
}
function sectionLengths(sections){
  return sections.map(function(s){ return [s[0], Array.from(s[1]).length]; });
}

function implSections(t){
  var L = [], br = hBranch(t.id);
  L.push("# 实现任务 " + t.id + "：" + t.title);
  L.push("");
  L.push("只做这一个任务，别顺手改别处。下面的信息够开工；要更多上下文再翻文档。");
  L.push("");
  L.push("本会话无人值守：权限已经全给你了，不要停下来要授权、要确认，也不要以提问收尾。" +
         "提示词与仓库现状对不上时按下面写好的办法自己定，把怎么定的写进回报的「自行裁决」段。" +
         "现成办法解不了的岔路口交 Jev 裁决；只有明确的授权红线才问用户。");
  L.push("");
  L.push(promptHead(t));
  L.push("任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立") + "；提示词生成器 " + (HC.version || "旧版"));
  L.push(roleBlock(t, "impl"));
  L.push("");
  L.push(vaultRefs(t));
  L.push("");
  L.push("## 验收标准（验收的唯一依据，逐条都要满足）");
  acceptLines(t.accept).forEach(function(x){ L.push(x); });
  L.push("");
  L.push("## 必须处理的边界");
  L.push(edgeBlock(t.edges));
  [wiringBlock(t), depCodeBlock(t), refsBlock(t)].forEach(function(block){ if(block) L.push(block); });
  var ps = pathsOf(t.id);
  if(ps.length){
    L.push(""); L.push("## 只改这些路径");
    ps.forEach(function(p){ L.push("- " + p); });
    var rv = rivalsOf(t.id);
    L.push("这是实施、审查和并行排程共用的有效范围。测试、包导出、依赖清单和共享基础必须列在这里；缺少必需文件时回报具体路径，由审查方修补 taskPaths/supportPaths 并核对冲突，不擅自新增公共基础或放宽范围。");
    L.push("其余范围外的文件不动；文档漏列则提出定点补丁，不重新开始本任务。" +
      (rv.length ? rv.map(function(x){ return x.id; }).join("、") +
                   " 也会碰这些路径，别动其中的公共结构（共享类型、路由表、全局配置），必须动就在回报里单列。" : ""));
  }
  var sk = skillBlock(t, "impl"); if(sk) L.push(sk);
  L.push("");
  L.push("## 步骤");
  var slug = t.id.toLowerCase(), wt = "../" + HREPO + "-" + slug, hasDeps = (t.deps||[]).length > 0;
  L.push("0. 工作目录。先 git worktree list 看自己在哪：");
  L.push("   - 在主检出（列表第一行）→ 别的会话可能也在这里切分支，先开自己的：git fetch origin " + HMAIN +
         " && git worktree add -b " + br + " " + wt + " origin/" + HMAIN + "，然后 cd 进去（分支已存在就去掉 -b；目录已存在就直接进）");
  L.push("   - 已在某个工作树里（窗口序列开的 ../" + HREPO + "-w<N> 之类）→ 就地：git fetch origin " + HMAIN +
         " && git checkout -b " + br + " origin/" + HMAIN + "（分支已存在就 git checkout " + br + "）");
  L.push("   进去后先装依赖，node_modules 这类不跟工作树走；planning 一类工作文件放仓库外的 ../.codex-plans/" + HREPO + "-" + slug + "/，别放仓库根目录。之后所有命令都在这个目录里跑。");
  L.push("   本任务只允许这两个仓库外目录：工作树 " + wt + "（或窗口序列给你的 ../" + HREPO + "-w<N>）与 planning ../.codex-plans/" + HREPO + "-" + slug + "/。" +
         "不许 git clone 一份仓库，不许自造 ../" + HREPO + "-review-" + slug + "、../" + t.id + "-review.<随机> 之类目录；审查方也在这同一个工作树里干活。" +
         "Windows 侧绝不跑 git worktree prune——WSL 建的活工作树在 Windows 显示 prunable，prune 会打断正在干活的会话。");
  L.push("1. 建栈。" + (hasDeps ? "前置 " + t.deps.join("、") + " 已合进 " + HMAIN + "，" : "本任务没有前置，") +
         "所以它是一条新栈的最底层，不叠在任何开放 PR 上：");
  L.push("   git config rerere.enabled true && git config remote.pushDefault origin && gh stack init --base " + HMAIN + " " + br);
  L.push("   （该分支已经检出，init 会直接收编它；已在栈里就 gh stack checkout " + br + "。" +
         "别用 gh stack add：它只能往开放的栈上叠层，前置的 PR 已合并、栈已关闭，会报 All branches in this stack have been merged——看到这句就是该走 init，不是要问人。" +
         (hasDeps ? "唯一例外：gh pr list --state open --head " + HPRE + "<前置ID> 显示某个前置的 PR 还开着，说明交接台状态被手点过了，那就叠上去：" +
                    "gh stack checkout " + HPRE + "<前置ID> && gh stack add " + br + "，并写进「自行裁决」）" : "）"));
  L.push("2. 实现，逐条对照验收标准与边界自检；然后跑测试：本任务有效路径下的测试文件 + 验收引用的 E-XX 对应用例必跑，其余按 dsh-pre-push-checks 挑最小充分集；lint 与测试命令在 17-测试策略，没写就 TESTS 记 skipped 并写明原因、回报里记一条 doc-issue，不猜命令。红的先修再交，别带着红提 PR。");
  L.push("3. 提交、推送、开 PR（审查方靠 PR 看 diff，没有 PR 它无从下手）：");
  L.push("   git status --short 核对后只加本任务的文件：git add -- <路径…>（不用 git add -A，会把工作文件和别的会话的东西带进去）");
  L.push("   git commit -m \"" + t.id + " " + shq(t.title) + "\"");
  L.push("   gh stack push && gh stack submit --auto --open");
  L.push("4. 回填知识库（下一节），再交审查。落地由审查方合并（单 PR 走 gh pr merge，多层才 gh stack merge），你不合，也不碰别层分支。");
  L.push("");
  L.push("## 交活前回填");
  L.push(HDOCS + "/图谱/任务/" + t.id + ".md 的两个受保护区块，只写标记之间：");
  L.push("- <!-- code:begin --> … <!-- code:end -->：一行一处，`路径:行号` — 干什么" +
         (t.edges.length ? "（关联的边界写上，如 " + t.edges[0] + "）" : "") + "，路径相对项目根");
  L.push("- <!-- notes:begin --> … <!-- notes:end -->：写代码里看不出来的——为什么这么选、否掉了什么、踩了什么坑；" +
         "不复述代码干了什么。判准：三个月后有人改这段代码，这条能不能拦住他踩同一个坑");
  L.push("写完跑：python " + HDOCS + "/_run/build_vault.py " + HDOCS);
  L.push("");
  L.push("## 不要做");
  L.push("- 实施方不擅改任务定义；文档问题回报具体条款，审查方可按既定要求在原 PR 定点修补。派生正文由脚本同步，受保护回填区可编辑。");
  L.push("- 不做别的任务、不提前做后面的；技术栈已列的依赖直接加，技术栈外是否必需交 Jev 裁，不能借裁决擅自扩大已授权范围");
  L.push("");
  L.push("## 收到返工指令时");
  L.push("只改指令列出的编号条目，不借机重构；哪条不成立就在回报里写理由，不默默跳过、也不照改你认为错的方案；" +
         "改完新提交（不 amend、不 force）再 gh stack push；回报按编号写改了哪个文件哪一行、加了什么测试。" +
         "在你原来的工作树里改（" + wt + " 或窗口目录），不要再开一个。");
  if(HO.conventions){ L.push(""); L.push("## 本项目约定"); L.push(HO.conventions); }
  L.push("");
  L.push("## 回报");
  L.push("改了哪些文件；每条验收标准落在哪个文件哪一行；每条边界怎么处理的；回填了没有；有没有偏离文档。含糊会被打回。");
  L.push("「自行裁决」一段：逐条写冲突、选项、Jev 的 line/model/option、采纳动作及清单外文件与理由；没有就写「无」。审查方逐条复核，缺项不能判通过。");
  L.push("入口可达证据：<从哪个入口怎么到达本任务产出，命令或路径>；没有接线要求写「无」");
  L.push("TESTS: <pass | fail | skipped> → 跑的命令与结果；skipped 写原因（17 节没命令就记 doc-issue）");
  L.push("末行：READY_FOR_REVIEW: " + br + " <PR 链接>");
  L.push(jevAdjudication(t.id + ":impl"));
  var appendix = appendixBlock(t); if(appendix) L.push(appendix);
  return promptSections(L.join("\n"));
}

function buildImpl(t){ return implSections(t).map(function(s){ return s[1]; }).join("\n"); }

/* 审查提示词。三条设计原则，都是从「审查方审了又审、永远不落地」这个实测问题倒推出来的：
   1. 问题分阻断与非阻断两级，只有阻断项才打回；
   2. 打回最多两轮，第二轮只核上一轮列出的条目，之后由审查方自己修完落地——环必须有出口；
   3. 结论之后紧跟动作：pass 一口气做完回填、记录落地、提交、合并；rework 产出可直接粘给实施方的
      返工指令；NEXT 一行告诉用户下一步点什么。轮次靠 PR 评论留档，换会话也接得上。 */
function buildReview(t){
  if(landedNeedsReview(t.id)) return buildLandedReview(t, false);
  var L = [], up = dependentsOf(t.id), br = hBranch(t.id), fe = isFrontend(t.module);
  var az = archBlock(t.module, t);
  var note = HDOCS + "/图谱/任务/" + t.id + ".md";
  L.push("# 审查任务 " + t.id + "：" + t.title);
  L.push("");
  L.push("代码在栈分支 " + br + "，PR 已提。你是验收方，目标是让这一层以正确状态尽快落地，不是找出尽可能多的问题：" +
         "清单只跑一轮，然后必须给结论并做动作，不来回。");
  L.push("");
  L.push(promptHead(t));
  L.push("任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立") + "；提示词生成器 " + (HC.version || "旧版"));
  L.push(roleBlock(t, "review"));
  L.push("");
  L.push("## 验收标准（唯一依据，逐条核）");
  acceptLines(t.accept).forEach(function(x){ L.push(x); });
  L.push("");
  L.push("## 必须处理的边界（逐条去代码里找处理）");
  L.push(edgeBlock(t.edges));
  [wiringBlock(t), depCodeBlock(t), refsBlock(t)].forEach(function(block){ if(block) L.push(block); });
  var ps = pathsOf(t.id);
  if(ps.length){
    L.push(""); L.push("## 有效改动路径（实施、审查与排程共用）");
    ps.forEach(function(p){ L.push("- " + p); });
    L.push("这是与实施和排程共用的有效范围。若本任务既定产出必需的测试、包导出或支持文件漏列，审查方先定点修补源配置并检查相关文件冲突，再按修正后的范围验收。不能因合理的文档补丁自动打回，也不能无限放行共享文件。");
  }
  var sk = skillBlock(t, "review"); if(sk) L.push(sk);
  L.push("");
  L.push("## 怎么审（一轮）");
  L.push("先核对当前契约：python \"" + HDOCS + "/_run/maintain_docs.py\" \"" + HDOCS + "\" status --task " + t.id + "。复制的版本过期则读当前派发包；保留原 PR，复核变化条款，不重建分支。");
  L.push("契约复核是审查的一部分：「实施」按前置落地与收口闸门解锁，不要求提前登记语义复核，所以本任务多半还没登记复核。status 显示 ready=false 且原因是「待语义复核」→ 本轮核对后用 verify 登记；原因是明确错误 → 先走下面的文档补丁。--landed 会拒绝没登记的任务。");
  var slug = t.id.toLowerCase(), wt = "../" + HREPO + "-" + slug, plans = "../.codex-plans/" + HREPO + "-" + slug;
  L.push("工作目录：实施方按提示词在自己的工作树里做，一般是 " + wt + "（git worktree list 能看到）。要动这条分支就 cd 进那个工作树——" +
         "分支已在那儿检出，主检出里 gh stack checkout 会被 git 拒绝；工作树没了就 git worktree add " + wt + " " + br + "。下面说「切到 " + br + "」都指这个动作。" +
         "本任务只允许两个仓库外目录：工作树 " + wt + " 与 planning " + plans + "/。审查方在同一个工作树里干活：不许 git clone 一份仓库，不许自造 ../" + HREPO + "-review-" + slug + "、../" + t.id + "-review.<随机> 之类目录。" +
         "Windows 侧绝不跑 git worktree prune——WSL 建的活工作树在 Windows 显示 prunable，prune 会打断正在干活的会话。");
  L.push("0. 轮次：gh pr view " + br + " --comments。有「REVIEW-ROUND」评论 → 第 N+1 轮，只核那些条目，每条写已修/未修；没有 → 第 1 轮，跑全清单。");
  L.push("   没有 PR 就自己补开，不算实施方的错：切到 " + br + " → gh stack submit --auto --open");
  L.push("1. gh pr diff " + br + "（栈里每层 PR 只含本层，正是要审的范围）；在该分支上复跑测试与 lint（命令在 17-测试策略；本任务有效路径下的测试文件 + 验收引用的 E-XX 对应用例必跑，其余按 dsh-pre-push-checks 挑）。红即阻断项，进 REWORK；17 节没命令就 TESTS 记 skipped 并写进 DOC_ISSUE，不猜命令。");
  L.push("2. 逐条验收标准 → 指出文件:行；指不出来就是不满足");
  L.push("3. 逐条边界 → 指出文件:行；找不到就是漏了");
  L.push("4. 范围外改动" + (ps.length ? "（路径清单之外的文件）" : ""));
  L.push("5. 偏离文档约定：数据模型、接口、技术栈" + (az ? "、框架架构" : "") + (HO.design && fe ? "、视觉方向" : ""));
  L.push("6. 回填了没有：" + note);
  L.push("7. 打完勾再调 dsh-code-review 补语义评审——「做了，但做对了没」，逐条打勾发现不了");
  L.push("核对最终任务包的前置能力、有效路径、13/17/19 对应要求、接口字段与验收阶段；完成后填写 status 给出的 task-contract 证据模板，运行 maintain_docs.py verify --task " + t.id + " --evidence <证据JSON>（带同一文档目录）。脚本只登记真实复核，不自动证明语义通过。");
  if(fe) L.push("8. 界面任务必须有从真实服务录的 GIF（record-browser-gif 核它）；没有不算 pass");
  L.push((fe ? "9" : "8") + ". 反造假扫描：① 在有效路径内 grep `not implemented|placeholder|stub|TODO|待接入|后续接入`，命中生产文件即阻断；② 门禁 / 闸门 / 探测函数返回硬编码 `true`/固定值即阻断；③ 注册表（接线要求段列的文件）里没有本任务条目即未接线、阻断；④ 前置代码位置里已有的类型 / 枚举 / 工具在本任务被另写一套即阻断；⑤ 界面任务 GIF 必须显示已加载样式（token 类的 computed style 生效），默认控件外观 = 未加载 = 阻断；⑥ 测试钩子（`window.__x`、`globalThis.__x`）出现在生产代码即阻断。" +
         (hasJudgments(t) ? "⑦ 判断层：TypeSafe 客户端在生产代码里被固定应答替换、阈值门禁恒返回通过、消费方只取 argmax 无视 confidence 分支，任一命中即阻断；验收证据是一次真实调用记录的 model 字段，测试全绿不算。" : ""));
  if(hasJudgments(t)) L.push((fe ? "10" : "9") + ". 判断层：TYPESAFE_API_KEY 未设置就不给结论，NEXT 写「请把 TYPESAFE_API_KEY 放进 .env（不进仓库）后再点『审查』」；设了就按 10 节语义判断契约逐问题核 ID、原语、criteria 兜底与阈值来源，并跑 17 节的判断用例集。");
  L.push("");
  L.push("   TypeSafe 复核（可选，第二意见不替代上面任何一步）：把 gh pr diff 的正文与你回报里的断言写成 state（断言翻成英文，diff 原样；Jev 英文最准），跑 python \"" + HDOCS + "/_run/typesafe_ask.py\" --log \"" + HDOCS + "/_run/judgments.jsonl\" --label " + t.id + " run review --state <文件>；" +
         "五个造假 noul 任一 yes 就回去人工核那一处，claim_* 为 contradicts/absent 的断言不许写进 EVIDENCE；输出 skipped（没密钥）照常继续，在回报 TS_CHECK 行写 skipped。");
  L.push((fe ? (hasJudgments(t) ? "11" : "10") : (hasJudgments(t) ? "10" : "9")) + ". 审查实施方的「自行裁决」：每条复用它列出的全部候选，补入你从 diff 得到的新事实，运行 adjudicate（UI/UX 用 design）。Jev 与实施方不一致时以本次 Jev option 为准；漏列候选、无 Jev model/line、skipped/error 或裁决动作未落到 diff，均为阻断。审查任务自己产生的岔路口也按同一协议裁，不能在 NEXT 里把普通技术或 UI/UX 选择交给用户。");
  L.push(jevAdjudication(t.id + ":review"));
  L.push("## 分级：只有阻断项才打回");
  L.push("阻断项：验收标准不满足；边界没处理；范围外改动且影响别的任务；违反 06/07/08 的分层与共用约定；数据会丢或错、权限能绕；测试红；生产文件命中占位/桩词；门禁/闸门/探测硬编码 true 或固定值；注册表缺本任务条目；重复实现前置已有类型/枚举/工具；GIF 样式未加载（token 类 computed style 未生效）；生产代码含 window.__x/globalThis.__x 测试钩子" + (hasJudgments(t) ? "；判断层客户端被固定应答替换、阈值门禁恒通过、无视 confidence 分支" : "") + "。");
  L.push("非阻断项（命名、注释、小重复、格式、回填措辞、几行改完且不改行为的小毛病）不构成 rework：" +
         "不超过约 30 行、不动接口与数据结构的你自己顺手改——切到 " + br +
         " → 改 → git commit -m \"" + t.id + " review-fix: <改了什么>\" → gh stack push；更大的进 FOLLOW_UP，之后单开任务。「感觉还能更好」不是阻断项。");
  L.push("");
  L.push("## 结论与动作");
  L.push("- pass：没有阻断项 → 直接走「落地」，一步不停。");
  L.push("- rework：有阻断项 → REWORK 写成 R1、R2…；末尾附「返工指令」（模板见下）；贴到 PR 留档：gh pr comment " + br +
         " --body-file <文件>（首行 REVIEW-ROUND N）；然后停下，等实施方推送、用户再点「审查」。");
  L.push("  第 2 轮只核上一轮条目，不新增无关阻断项。**最多两轮**：之后剩的具体代码错误由你改掉、加测试、提交、push，" +
         "记进 FIXED_BY_REVIEWER，按 pass 落地；剩的是方向性问题（方案不对、任务定义不可实现）→ 列候选交 Jev 裁决，再按 spec_change 标记走补丁；只有授权红线才问用户。");
  L.push("- 局部文档问题：先走下面的 DOC_PATCH，在原任务分支修补对应源条款、任务和有效范围，同步并复验；代码符合既定要求即 pass，继续本 PR 的 commit/push/落地。普通补丁不重跑需求、架构、任务拆分或整套 skill，不重新派发整个任务。");
  L.push("- doc-issue 仅用于补丁后仍缺必要裁定或没有可行契约的情形。列具体冲突与影响，只暂停受影响任务；不得降低验收迁就代码。补丁已修而代码仍有缺陷则保留补丁，给原 PR 精确 rework 条目。");
  L.push(docPatchBlock(t));
  L.push("");
  L.push("## 落地（pass 之后一口气做完）");
  L.push("1. 回填：" + note + " 的 code / notes 两个受保护区块。实施方填了就核质量（dsh-prose-standard、dsh-trim-cot-leakage 各过一遍），" +
         "缺了或写成废话就自己补。切到 " + br + "，在仓库根跑 python " + HDOCS + "/_run/build_vault.py " + HDOCS + "（后面几步都在这个工作树里）");
  L.push("2. 记录落地：python " + HDOCS + "/_run/build_docs.py " + HDOCS + " --landed " + t.id +
         "　（写进任务笔记的 status、docs-data.js 的 progress 与本机 _run/progress.js；交接台刷新后这一行变「已落地」，下游按前置与收口闸门解锁）");
  L.push("3. 一起进仓库：切到 " + br + " → git add " + HDOCS + " && git commit -m \"" + t.id + " 回填知识库并记录落地\" && gh stack push");
  L.push("4. 证据：第 1 步已跑过的测试不重复跑；只对落地前新增的改动（回填、rebase）按 dsh-pre-push-checks 补跑；红了回头按阻断项处理");
  L.push("5. 还是 draft 就 gh pr ready " + br);
  L.push("6. 先数栈里开放的 PR：gh stack view --json。只有本层这一个（base 是主干、上面没叠别层）→ GitHub 不会为单个 PR 建栈对象，按普通 PR 合：gh pr merge <本层 PR 号> --merge，" +
         "这是前置都已落地的任务的常态，不要为了凑栈去等下一个任务或开空 PR；两个以上 → gh stack merge <本层 PR 号> --yes --merge，" + (up.length
      ? "本层连同下面未合的层一起合；依赖本层的 " + up.map(function(x){ return x.id; }).join("、") +
        " 正常还没开工，若已叠在上面，其 PR base 由 GitHub 改到主干，让它们的会话跑 gh stack sync"
      : "本层是栈顶，合它就是整栈落地") + "。等每个 PR 都报 MERGED 才算落地；合并失败就把任务笔记的 status 改回 review 并 push，PR 还开着时不许留 done");
  L.push("7. 清理（落地当场做，不留到以后）：gh pr list --state open --base " + br + " --json number --jq length，不是 0 不许删；" +
         "是 0 就依次：git worktree remove " + wt + "（有未提交文件时看清是什么再决定 --force；node_modules 报 not empty 就 rm -rf " + wt + "）→ git branch -d " + br +
         " → rm -rf " + plans + "。工作树和 planning 目录留着只会越积越多；不确定漏了哪些就跑 python " + HDOCS + "/_run/maintain_docs.py " + HDOCS + " workspace 看清单。");
  L.push("8. 主检出 git pull 后刷新交接台：落地记录随 docs-data.js 进了仓库，换检出目录不必重跑 --landed。");
  L.push("");
  L.push("## 输出格式（严格遵守）");
  L.push("VERDICT: pass | rework | doc-issue");
  L.push("ROUND: N（PR 上 REVIEW-ROUND 评论数 + 1）");
  L.push("ACCEPTANCE");
  L.push("- 1) 满足 → 文件:行　｜　不满足 → 缺什么");
  L.push("WIRING");
  var wiring = wiringFor(t), wiredFiles = [];
  Object.keys(wiring).forEach(function(k){ wiring[k].forEach(function(p){
    if(wiredFiles.indexOf(p) < 0) wiredFiles.push(p);
  }); });
  wiredFiles.forEach(function(p){ L.push("- 注册点 " + p + " 已含本任务条目 → 文件:行 ｜ 未接线 → 阻断"); });
  if(!wiredFiles.length) L.push("- 无");
  L.push("EDGES");
  L.push("- E-XX 已处理 → 文件:行　｜　未处理 → 缺什么");
  L.push("VAULT");
  L.push("- 代码位置：已回填 / 未回填　｜　实施沉淀：已回填 / 未回填");
  L.push("TESTS");
  L.push("- pass | fail | skipped → 跑的命令与结果；fail 即阻断，skipped 写原因");
  L.push("TS_CHECK");
  L.push("- run review 返回的 line，或 skipped");
  L.push("OUT_OF_SCOPE");
  L.push("- 范围外改动；没有写 none");
  L.push("ADJUDICATION");
  L.push("- 每条：来源（实施/审查）→ 候选 → Jev line/model/option → 一致或改正 → 动作；没有写 none");
  L.push("DOC_ISSUE");
  L.push("- 文档本身的问题；没有写 none");
  L.push("REWORK");
  L.push("- R1 现象 → 文件:行 → 改成什么样 → 怎么验证；造假类阻断写明扫描命中位置；pass 写 none");
  L.push("FIXED_BY_REVIEWER");
  L.push("- 你顺手改掉的非阻断项 → commit；没有写 none");
  L.push("FOLLOW_UP");
  L.push("- 之后单开任务的事；没有写 none");
  L.push("NEXT");
  L.push("- 一行给用户，三选一：「把下面的返工指令发给实施模型，它推送后再点「审查」」｜" +
         "「已 merge 并记录落地，刷新交接台；一批全部落地后先收口再派下一批（没变就手点状态标签）」｜「文档补丁已同步并继续原 PR」或「Jev 待恢复：<state 路径与错误>」；普通技术或 UI/UX 选择不得写成让用户裁决");
  L.push("");
  L.push("rework 时末尾附，原样可粘（围栏语言固定为 rework，下游靠它定位返工块）：");
  L.push("```rework");
  L.push("# 返工 " + t.id + "：" + t.title + "（第 N 轮）");
  L.push("分支 " + br + "。只改下面几条，别动别的；改完 git commit + gh stack push；回报按编号写改了哪个文件哪一行。");
  L.push("R1 …");
  L.push("```");
  var appendix = appendixBlock(t); if(appendix) L.push(appendix);
  return L.join("\n");
}

function buildContractReview(t){
  return ["# 派发前核对任务要求 " + t.id + "：" + t.title,
    "本任务尚未开始实现。这是任务要求复核，不创建代码 PR、不建任务分支、不执行落地。",
    promptHead(t), "任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立"),
    "读取 _MOC 与本任务关联的架构、13 边界、17 测试、19 任务和有效路径，核对能力前置、接口字段、接线责任与验收阶段是否一致。",
    "验收：", acceptLines(t.accept).join("\n"), "边界：", edgeBlock(t.edges),
    "有效范围：", pathsOf(t.id).join("\n"),
    "运行 python \"" + HDOCS + "/_run/maintain_docs.py\" \"" + HDOCS + "\" status --task " + t.id + " 读取当前版本与证据模板。",
    "要求一致则填写真实证据并运行同一命令的 verify --task " + t.id + " --evidence <JSON>。派发本身按前置落地与收口闸门解锁，不要求提前登记语义复核，这一步提前做完可以让审查阶段少一道工序。",
    "发现文档局部问题则按 references/doc-maintenance.md 保存基线并定点修补、同步、复核；没有代码 PR 时不伪造 PR 号。不得放宽验收标准。",
    jevAdjudication(t.id + ":contract-review")
  ].join("\n");
}
function docPatchBlock(t){
  return ["", "## 文档补丁（审查方执行，沿用原 PR）",
    "1. 改源之前保存基线：python \"" + HDOCS + "/_run/maintain_docs.py\" \"" + HDOCS + "\" begin --task " + t.id + " --patch <补丁ID> --pr <原PR号> --reason <修正依据>。已存在则按记录续做，不重建。",
    "2. 按原始需求与已定契约修正对应源文档/任务配置；补齐必要路径及测试、依赖、接线责任。不手改生成正文，不删验收或降低边界要求。",
    "3. 定点同步：python \"" + HDOCS + "/_run/maintain_docs.py\" \"" + HDOCS + "\" sync --patch <补丁ID>。读取差异、受影响任务、续做提示词和证据模板。脚本不生成需求、不重做架构。",
    "4. 复核受影响契约及代码，运行必要检查；填写真实证据后执行 verify --task " + t.id + " --evidence <证据JSON> --patch <补丁ID>（同一维护命令前缀）。补丁前未受影响的证据可复用。",
    "5. 在原分支提交源补丁与关联产物并 push。代码已满足则继续 pass 落地；否则仅给变化条目 rework，使用派发包的 resume 提示词。",
    "输出保留 pass/rework/doc-issue 三态，可附 DOC_PATCH：源条款 → 依据 → 修改 → 影响 → 复验与提交。只有真实阻断未解决才暂停落地。"
  ].join("\n");
}
function buildLandedReview(t, resume){
  var note = HDOCS + "/图谱/任务/" + t.id + ".md";
  return ["# " + (resume ? "继续复验已落地任务 " : "复验已落地任务 ") + t.id + "：" + t.title,
    "本任务有已落地历史，现在仅因契约变化待复验。代码依据是已合入 " + HMAIN + " 的当前代码与任务回填；历史 PR 只作为已合入实现和原验收的证据。",
    "不要创建空 PR，不重新初始化旧任务分支，不向已经 MERGED 的原 PR 追加提交或要求再次合并。",
    promptHead(t), "任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立"),
    "先读 " + note + " 的代码位置、实施沉淀和已有落地记录，以及本次补丁的差异与复验清单（_run/revalidation.json 里本任务的 patches[].changedFields 列出了变化字段；只有共享章节变化时只核该章节对本任务的影响）。",
    "若已有本次复验或修复的工作树、分支和开放 PR，沿用它们的实际标识；不假定它们仍是旧任务的分支或历史 PR。",
    "仅核对变化条款及其直接影响，保留已有代码、回填和 done 历史，不按完整实施流程重做。",
    "验收：", acceptLines(t.accept).join("\n"), "边界：", edgeBlock(t.edges),
    "有效范围：", pathsOf(t.id).join("\n"), wiringBlock(t), depCodeBlock(t), refsBlock(t),
    "运行 python \"" + HDOCS + "/_run/maintain_docs.py\" \"" + HDOCS + "\" status --task " + t.id + " 读取当前版本与证据模板。",
    "契约复核完成后，用同一维护命令的 verify --task " + t.id + " --evidence <证据JSON> 登记真实证据。verify 只登记文档契约复核，不证明代码验收或 CI 通过，也不清除代码复验标记。",
    "无需代码修改时，直接复验已合入代码并记录必要检查结果，不为复验补开代码 PR。确有代码差异才按正常修复流程处理：沿用本次修复的工作树和开放 PR；没有时使用实际修复分支和新 PR，不继续已经 MERGED 的历史 PR。",
    "只有代码完成实际验收、必要检查通过，且所需修复已确认合入 " + HMAIN + " 后，才运行 python \"" + HDOCS + "/_run/build_docs.py\" \"" + HDOCS + "\" --landed " + t.id + " 清除本任务的代码复验标记；没有代码差异时以当前已合入代码为依据。不能靠手点状态、删除标记或契约 pass 代替代码验收。",
    "输出 VERDICT: pass | rework | doc-issue；列明变化条款、代码位置、必要检查结果和代码复验是否完成。剩余代码错误给精确 rework；普通岔路口交 Jev，只有授权红线才给用户，不因已有 done 历史自动判 pass。", jevAdjudication(t.id + ":landed-review"), appendixBlock(t)
  ].join("\n");
}
function buildResume(t){
  if(landedNeedsReview(t.id)) return buildLandedReview(t, true);
  return ["# 继续原任务 " + t.id + "：" + t.title,
    "沿用分支 " + hBranch(t.id) + "、现有工作树和原 PR；不要创建新任务或重新初始化分支。",
    "任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立"),
    "读取 _run/patches/ 中本次补丁的差异和复验清单，只处理列出的条目及其直接影响。没有差异说明时先核对现有 PR 的返工记录，不按完整实施流程重做。",
    "修正后的验收：", acceptLines(t.accept).join("\n"),
    "有效范围：", pathsOf(t.id).join("\n"),
    "保留已有代码和回填；修改后运行必要检查、追加提交并 push，继续原 PR 审查。",
    jevAdjudication(t.id + ":resume")
  ].join("\n");
}

function buildKickoff(){
  var tasks = DT.tasks || [], mods = DT.modules || [];
  var lv = layerOf(tasks.map(function(t){ return t.id; }), function(id){
    var t = taskById(id); return (t && t.deps) || [];
  });
  var first = tasks.filter(function(t){ return lv[t.id] === 0; }).map(function(t){ return t.id; });
  var days = Math.round(tasks.reduce(function(s,x){ return s + (x.est||0); }, 0) * 10) / 10;
  var L = [];
  L.push("# " + D.project + "　开工交代");
  L.push("");
  L.push("你负责按这套开发文档写代码。任务会一个一个发给你，每次只做一个。这条是总交代，只发一次。");
  L.push("");
  L.push("## 项目");
  if(HO.stack) L.push("- 技术栈：" + HO.stack);
  L.push("- 开发文档：" + HDOCS);
  L.push("- 规模：" + mods.length + " 个模块 / " + tasks.length + " 个任务 / 合计 " + days + " 人天");
  L.push("");
  L.push("## 这个项目有知识库，别去通读文档");
  L.push(HDOCS + " 同时是一个 Obsidian 知识库：每个模块、任务、边界各一篇笔记，互相用 [[链接]] 连着。要什么顺着链接取什么，不要整本读。");
  L.push("- `" + HDOCS + "/_MOC.md`　总索引，一页看完全貌");
  L.push("- `" + HDOCS + "/图谱/任务/<任务ID>.md`　任务卡，含前人留下的实施沉淀");
  L.push("- `" + HDOCS + "/图谱/模块/<模块ID>.md`　模块职责与已有代码位置");
  L.push("- `" + HDOCS + "/图谱/边界/<边界ID>.md`　某种异常该怎么处理");
  L.push("");
  L.push("## 先做这些（只做一次）");
  L.push("1. 读 `" + HDOCS + "/_MOC.md`，建立全貌。");
  L.push("2. 只有两节需要整节读：02 非目标、05 技术栈。其余按需顺链接取。");
  L.push("3. 按技术栈搭好工程骨架，初始化 git，提交一个基线。");
  L.push("4. 确认栈工具可用：gh stack --version。不可用就停下来说一声，别退回 git merge——整套落地流程都建立在官方栈上。");
  if(HO.wiring && HO.wiring.judgments) L.push("5. 本项目接了 TypeSafe 判断层（System One，注册表 " + [].concat(HO.wiring.judgments).join("、") + "）：TYPESAFE_API_KEY 由用户在 https://console.typesafe.ai/keys 创建、放进 .env（不进仓库、不进前端产物）；没拿到也照做判断层任务——单测用录制应答（只许放测试目录），真实调用留给审查，回报「自行裁决」写明密钥缺失。");
  L.push("");
  L.push("项目根的 AGENTS.md 里写着同一套规矩。你的工具如果会自动读它，那你已经知道了。");
  L.push("");
  L.push("## 你会用到这些技能");
  L.push("每个任务的提示词都会点名在哪一步调哪个技能。先装上：");
  L.push("- `gh-stack`　栈命令与非交互标志；不带标志会卡死在全屏 TUI，还不报错");
  L.push("- `dsh-prose-standard`　写实施沉淀时判断「写够了没有」——单纯变短不算改进");
  L.push("- `dsh-trim-cot-leakage`　沉淀写完过一遍，清掉只有当时在场的人才解析得了的话");
  if(HO.wiring && HO.wiring.judgments){
    L.push("- `typesafe-ai`　判断层任务：三种原语怎么选、问题怎么写、概率与 confidence 怎么用；正本是 live docs，不凭记忆编请求字段。Claude Code 装 `claude plugin marketplace add typesafe-ai/skills && claude plugin install typesafe@typesafe-ai`，别的 agent 用 `npx skills add typesafe-ai/skills --skill typesafe-ai`");
  }
  if((HO.frontendModules||[]).length){
    L.push("- `record-browser-gif`　界面任务的验收证据：从真实服务录一段 GIF，不许 mock");
  }
  L.push("除 `gh-stack` 外都来自 deepseek-harness 仓库的 `.agents/skills/`。装不上也能干活，只是拿不到完整判准。");
  L.push("");
  L.push("## 每个任务都适用的规矩");
  L.push("- 一批全部落地后先收口再派下一批；交接台默认上锁。紧邻上一批的收口记录 verdict 为 clean/fixed 后解锁；handoff.wrapupGate:false 可关闭。");
  L.push("- 一个任务一层栈分支 " + HPRE + "<任务ID>：做完提交、gh stack push、gh stack submit --auto --open 开出 PR，不自己合并。");
  L.push("- 每个任务在自己的 git worktree 里做（../" + HREPO + "-<小写任务ID>，或窗口序列给的 ../" + HREPO + "-w<N>），几个会话不共用一个检出；planning 类工作文件放 ../.codex-plans/" + HREPO + "-<小写任务ID>/。" +
         "一个任务只允许这两个仓库外目录：不许 git clone 一份仓库，不许自造 ../" + HREPO + "-review-<id>、../<ID>-review.<随机> 之类目录；审查方在同一个工作树里干活。" +
         "Windows 侧绝不跑 git worktree prune——WSL 建的活工作树在 Windows 显示 prunable，prune 会打断别人的会话。落地后当场删工作树、分支和 planning 目录。");
  L.push("- 派给你的任务前置都已合进 " + HMAIN + "，所以每个任务都是新栈最底层：gh stack init。gh stack add 报 All branches in this stack have been merged 就是该 init，不用问。");
  L.push("- 无人值守：不要停下来要授权或确认；提示词写好的处理办法照做；普通技术、审查、BUG、收口与 UI/UX 岔路口都交 Jev，只有付费、不可逆删除、改变已定范围、对外承诺才问用户。");
  L.push("- gh stack 命令一律带非交互标志：view 用 --json、submit 用 --auto、merge 用 --yes。");
  L.push("- 只做当前任务范围内的事，不提前做后面的；不引入技术栈之外的依赖。");
  L.push("- 不改开发文档，也不手改 `图谱/` 下笔记的正文——那些是脚本派生的，重跑就没。文档有问题就说出来。");
  L.push("- 验收标准和边界编号是硬指标，每条都要能指到具体代码。");
  L.push("- 做完要回填知识库：代码位置和实施要点写进 `" + HDOCS + "/图谱/任务/<任务ID>.md` 的两个受保护区块，然后才交审查。没回填不给落地。");
  L.push("");
  L.push("## 模块");
  mods.forEach(function(m){
    L.push("- " + m.id + "　" + m.role + ((m.deps||[]).length ? "（依赖 " + m.deps.join("、") + "）" : ""));
  });
  L.push("");
  L.push("## 开工顺序");
  L.push("第一批无前置依赖、可立即并行：" + (first.join("、") || "—") + "。完整依赖关系见 `" + HDOCS + "/_MOC.md` 的依赖全景图。");
  if(HO.conventions){ L.push(""); L.push("## 本项目约定"); L.push(HO.conventions); }
  L.push("");
  L.push("准备好了回一句「就绪」，我发第一个任务。");
  L.push(jevAdjudication("kickoff"));
  return L.join("\n");
}

/* 查 bug 提示词：审查证明「文档要的都做了」，查 bug 假设一定做错了、去构造让它失败的输入。
   不改交接台状态。代码还在栈分支上就在那一层修，已进主干就另开 fix 栈，两种情况都写死。
   bugPrompt(t, landed) 是纯函数、不看进度：导出用 bugPrompt(t, false)——产品在任务落地前、
   在该任务的工作树里派查 bug 运行，代码还在栈分支上；页面按钮走 buildBug(t)，按此刻状态选措辞 */
function bugPrompt(t, landed){
  var L = [], br = hBranch(t.id), fe = isFrontend(t.module);
  var note = HDOCS + "/图谱/任务/" + t.id + ".md";
  L.push("# 查找 bug：" + t.id + "　" + t.title);
  L.push("");
  L.push("找出并修掉这个任务代码里的 bug。不是验收——验收只证明「文档要的做了」，证明不了「没做错」。假设一定有 bug，去证明它错；证明不了才算干净。");
  L.push("");
  L.push(promptHead(t));
  L.push("任务契约版本：" + ((HC.contracts[t.id] || {}).hash || "未建立") + "；提示词生成器 " + (HC.version || "旧版"));
  L.push("- 代码在哪：" + (landed
      ? "已合进 " + HMAIN + "，文件清单看 " + note + " 的「代码位置」"
      : "栈分支 " + br + "，还没合：进它的工作树（git worktree list；实施方一般开在 ../" + HREPO + "-" + t.id.toLowerCase() +
        "，主检出里 checkout 会被拒）；gh pr diff " + br + " 看本层改了什么"));
  L.push("");
  L.push("## 判断对错的依据（每条都是一个可以构造失败的地方）");
  L.push("验收标准：");
  acceptLines(t.accept).forEach(function(x){ L.push(x); });
  L.push("边界：");
  L.push(edgeBlock(t.edges));
  var refs = refsBlock(t); if(refs) L.push(refs);
  /* 不带架构段：查 bug 找的是错，架构偏离是审查的活。它在这个项目里占提示词七成篇幅 */
  var ps = pathsOf(t.id);
  if(ps.length){
    L.push(""); L.push("## 代码范围");
    ps.forEach(function(p){ L.push("- " + p); });
    L.push("修 bug 也只改这些路径；根因在范围外（前置任务的代码、共享层）不伸手，写进 NOT_FIXED。");
  }
  L.push("");
  L.push("## 怎么找（按顺序，每步留证据）");
  L.push("1. 对每条验收标准和每条边界，各构造至少一个想让它失败的输入或状态：空、超长、非法类型、边界值、重复提交、并发两次、中途失败、" +
         "权限不对、时序错乱、时区与精度。写成能重复跑的测试或脚本，跑一遍记结果。");
  L.push("2. 顺数据流走一遍：入口校验 → 业务 → 持久化 → 回显。专找四类：绕过校验的入口；缓存或回显读的不是权威来源；" +
         "事务外的副作用（发了通知没落库、落库了没发通知）；没释放的资源（连接、文件、定时器、监听）。");
  L.push("3. 和前置任务" + ((t.deps||[]).length ? "（" + t.deps.join("、") + "）" : "") +
         "的接缝：字段名、空值、错误码、枚举、时间格式、金额精度，两边是不是同一套。");
  L.push("4. 跑现有测试与 lint（命令在 17-测试策略；没写就 TESTS 记 skipped 并写明原因、NOT_FIXED 记一条 doc-issue，不猜命令）。");
  if(fe) L.push("5. 界面：组件八态（默认/悬停/聚焦/按下/禁用/加载/错误/空）有没有漏、键盘能不能走完、窄屏有没有横向溢出、" +
                "请求失败与空数据时长什么样。起真实服务点一遍。");
  L.push((fe ? "6" : "5") + ". 调 dsh-code-review 再扫一遍：接口两侧契约、生命周期与并发、绕过路径、借用 vs 拥有的状态、测试是否只重写实现。");
  L.push((fe ? "7" : "6") + ". 占位与桩扫描：① 在有效路径内 grep `not implemented|placeholder|stub|TODO|待接入|后续接入`，命中生产文件即阻断；② 门禁 / 闸门 / 探测函数返回硬编码 `true`/固定值即阻断；③ 按接线要求核注册表文件，没有本任务条目即未接线、阻断；④ 测试钩子（`window.__x`、`globalThis.__x`）出现在生产代码即阻断" + (hasJudgments(t) ? "；⑤ 判断层：生产代码里 TypeSafe 客户端被固定应答替换、阈值门禁恒通过、只取 argmax 无视 confidence 分支即阻断，并构造低置信输入看它走不走人工/降级分支" : "") + "。记录扫描命中位置。");
  L.push("");
  L.push("## 找到之后");
  L.push("- 先写复现（输入 → 实际 → 期望）再修；复现不出来的写进 SUSPECT，不算 bug。");
  L.push("- 只改根因不重构周边；每个修复配一个修复前失败、修复后通过的测试；收工前按 dsh-pre-push-checks 跑最小充分测试集。");
  L.push(landed
      ? "- 代码已在主干，修复另开一条栈，不直接推主干，也别在别人的检出里干：git fetch origin " + HMAIN + " && git worktree add -b fix/" + t.id +
        "-<一两个词> ../" + HREPO + "-fix-" + t.id.toLowerCase() + " origin/" + HMAIN + " → cd 进去 → gh stack init --base " + HMAIN + " fix/" + t.id +
        "-<一两个词> → git commit -m \"fix(" + t.id +
        "): <现象>\" → gh stack push && gh stack submit --auto --open"
      : "- 代码还在 " + br + "，就在这一层修：git commit -m \"fix(" + t.id + "): <现象>\" → gh stack push。不 amend 别人的提交，不 force。");
  L.push("- 不改开发文档；根因是文档写错或没写的，记进 NOT_FIXED 标「doc-issue」。");
  L.push(jevAdjudication(t.id + ":bug"));
  L.push("");
  L.push("## 输出格式（严格遵守）");
  L.push("TESTS");
  L.push("- pass | fail | skipped → 跑的命令与结果；skipped 写原因");
  L.push("BUGS");
  L.push("- B1 [S1 数据错或丢、权限能绕 | S2 功能错 | S3 体验与边角] 现象 → 复现 → 根因 → 文件:行");
  L.push("  没有写 none，并列出跑过的用例——没有证据的「没找到」不算");
  L.push("FIXED");
  L.push("- B1 → commit <hash>：改了什么、加了哪个测试");
  L.push("NOT_FIXED");
  L.push("- B2 → 为什么不修（根因在范围外 / 要改文档 / Jev 裁成 red_line / Jev 暂不可用）→ 建议；不得把普通修复选择交给用户");
  L.push("SUSPECT");
  L.push("- 怀疑但没复现的；没有写 none");
  L.push("NEXT");
  L.push("- 一行给用户：" + (landed
      ? "「修复 PR 已提：<链接>，按审查的方式核它再合」或「没找到 bug，主干不用动」"
      : "「已修并推送，重新点「审查」」或「没找到 bug，继续走审查 / 落地」"));
  return L.join("\n");
}
function buildBug(t){ return bugPrompt(t, isLanded(t.id)); }

/* 全项目查 bug：单任务审查只看自己那一层，任务之间的接缝没人管。
   范围取交接台里已落地的任务；一个都没有就按主干现有代码查，把全部任务列出来 */
function buildBugAll(){
  var tasks = DT.tasks || [], mods = DT.modules || [];
  var landed = tasks.filter(function(t){ return isLanded(t.id); });
  var scope = landed.length ? landed : tasks;
  var L = [];
  L.push("# " + D.project + "　全项目查 bug");
  L.push("");
  L.push("在已落地的代码里找 bug 并修掉。单个任务的审查只看自己那一层，看不见任务之间的接缝——这次专查接缝。假设一定有 bug，去证明它错；证明不了才算干净。");
  L.push("");
  L.push("## 项目");
  L.push("- 项目：" + D.project + (HO.stack ? "　｜　技术栈：" + HO.stack : "") + "　｜　主干：" + HMAIN);
  L.push("- 开发文档：" + HDOCS + "。知识库入口 " + HDOCS + "/_MOC.md；每个任务的代码位置在 图谱/任务/<任务ID>.md，先读它再开文件。");
  L.push("- 范围：" + (landed.length
      ? "交接台里已落地 " + landed.length + "/" + tasks.length + " 个任务，只查这些。"
      : "交接台里还没有任务标成已落地，按主干上现有的代码查；下面列的是全部任务。"));
  L.push("");
  L.push("## 查这些任务");
  var seen = {};
  mods.forEach(function(m){
    var ts = scope.filter(function(t){ return t.module === m.id; });
    if(!ts.length) return;
    L.push("- " + m.id + "　" + m.role);
    ts.forEach(function(t){
      seen[t.id] = 1;
      L.push("  - " + t.id + "　" + t.title + ((t.edges||[]).length ? "　边界 " + t.edges.join("、") : ""));
    });
  });
  scope.forEach(function(t){
    if(!seen[t.id]) L.push("- " + t.id + "　" + t.title + "（模块 " + t.module + "）");
  });
  L.push("");
  L.push("## 怎么找：五类接缝与占位扫描");
  L.push("1. 模块之间的调用：A 产出的字段、错误码、枚举、时间格式、精度，B 读的时候是不是同一套。判据是 10-接口约定。");
  L.push("2. 同一条边界被两个任务各兜一半：13 节里「模块」列和实现它的任务不在同一模块的边界，两边是不是都做了、有没有做成两套。");
  L.push("3. 共用约定（06 节）的执行：错误体系、环境变量、共享类型，有没有哪个模块自己另立一套。");
  L.push("4. 跨任务的状态与并发：一个任务写、另一个任务读的表或缓存，读到的是不是权威来源；两个入口同时改一条记录会怎样。");
  L.push("5. 主流程端到端跑一遍（09 节 UX 主路径 + 12 节时序图）：起真实服务，不 mock；每个失败分支都走一次。");
  L.push("6. 占位与桩扫描：对上列任务逐个读取契约的有效路径与接线要求；① 在有效路径内 grep `not implemented|placeholder|stub|TODO|待接入|后续接入`，命中生产文件即阻断；② 门禁 / 闸门 / 探测函数返回硬编码 `true`/固定值即阻断；③ 按接线要求核注册表文件，没有本任务条目即未接线、阻断；④ 测试钩子（`window.__x`、`globalThis.__x`）出现在生产代码即阻断。记录扫描命中位置。");
  L.push("");
  L.push("## 怎么做");
  L.push("- 先跑现有全部测试与 lint（命令在 17-测试策略；没写就 TESTS 记 skipped 并写明原因、NOT_FIXED 记一条 doc-issue，不猜命令）。红的先记下来，别顺手修——它可能就是线索。");
  L.push("- 每个 bug 先写复现再修；修根因不重构；每个修复配一个修复前失败、修复后通过的测试。");
  L.push("- 修复统一开一条栈，先开自己的工作树：git fetch origin " + HMAIN + " && git worktree add -b fix/<日期>-<一两个词> ../" + HREPO +
         "-fix-<日期> origin/" + HMAIN + " → cd 进去 → gh stack init --base " + HMAIN + " fix/<日期>-<一两个词>；相关的几处修在同一层，不相关的各起一层（gh stack add）。" +
         "提交写 fix(<任务ID>): <现象>；改完 gh stack push && gh stack submit --auto --open。不直接推主干。");
  L.push("- 不改开发文档；根因在文档的记进 NOT_FIXED 标「doc-issue」。调 dsh-code-review 的检查项扫接缝；挑测试集见 dsh-pre-push-checks。");
  L.push(jevAdjudication("project-bug"));
  L.push("");
  L.push("## 输出格式（严格遵守）");
  L.push("TESTS");
  L.push("- pass | fail | skipped → 跑的命令与结果；skipped 写原因");
  L.push("BUGS");
  L.push("- B1 [S1 数据错或丢、权限能绕 | S2 功能错 | S3 体验与边角] 涉及 <任务ID>：现象 → 复现 → 根因 → 文件:行");
  L.push("  没有写 none，并列出跑过的用例——没有证据的「没找到」不算");
  L.push("FIXED");
  L.push("- B1 → commit <hash>：改了什么、加了哪个测试");
  L.push("NOT_FIXED");
  L.push("- B2 → 为什么不修（要改文档 / Jev 裁成 red_line / Jev 暂不可用 / 牵动太大该单开任务）→ 建议；普通选择不得交用户");
  L.push("SUSPECT");
  L.push("- 怀疑但没复现的；没有写 none");
  L.push("NEXT");
  L.push("- 一行给用户：「修复栈已提，PR：<链接>；按审查的方式逐层核了再合」或「没找到 bug，附跑过的用例清单」");
  return L.join("\n");
}

/* 按钮上的复制反馈。独立成函数是因为交接台复制成功后会整块重画，
   原来那个按钮已经不在 DOM 里，「已复制」要补到新画出来的按钮上 */
function flashBtn(btn, ok){
  if(!btn) return;
  if(!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = ok ? "已复制" : "复制失败";
  btn.classList.remove("done", "err");
  btn.classList.add(ok ? "done" : "err");
  clearTimeout(btn._t);
  btn._t = setTimeout(function(){
    btn.textContent = btn.dataset.label;
    btn.classList.remove("done", "err");
  }, 1600);
}

/* file:// 下 clipboard API 在部分浏览器不可用，必须留 execCommand 这条退路，
   否则双击打开的 HTML 上按钮全是死的 */
function copyText(txt, btn, onSuccess){
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = txt; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch(e) { ok = false; }
    document.body.removeChild(ta);
    flashBtn(btn, ok);
    if(ok && onSuccess) onSuccess();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){
      flashBtn(btn, true);
      if(onSuccess) onSuccess();
    }, fallback);
  } else fallback();
}

/* ── 批次收口：一批全部落地后，把整批当整体做小结、跑测试、查接缝，走一条 PR 落地。
   默认闸门：未收口或有遗留时锁紧邻下一批的实施；wrapupGate=false 关闭，窗口工期预测不变，复制不改状态 ── */
function batchComplete(k){
  var g = batchLayers().by[k] || [];
  return g.length > 0 && g.every(function(t){ return isLanded(t.id); });
}
/* 某批的记录 = tasks 集合与当前批任务集合相等的记录里 date 最大的一条；批次号变化不影响匹配 */
function batchRecordsOf(k){
  var ids = (batchLayers().by[k] || []).map(function(t){ return t.id; });
  return Object.keys(BR).map(function(n){ return BR[n]; }).filter(function(r){
    var ts = (r && r.tasks || []).slice().sort();
    if(ts.length !== ids.length) return false;
    for(var i = 0; i < ids.length; i++) if(ts[i] !== ids[i]) return false;
    return true;
  }).sort(function(a, b){
    var x = String(a.date || ""), y = String(b.date || "");
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
function batchRecord(k){
  var rs = batchRecordsOf(k);
  if(!rs.length) return null;
  var rec = rs[rs.length - 1];
  var source = (batchLayers().by[k] || []).map(function(t){ return t.id; }).sort().join("\n");
  var pending = (DT.tasks || []).filter(function(t){
    return t.repair && (t.sourceBatchTasks || []).slice().sort().join("\n") === source && !isLanded(t.id);
  });
  if(pending.length && (rec.verdict === "clean" || rec.verdict === "fixed")){
    rec = Object.assign({}, rec, {verdict:"open", note:"返工任务未落地：" + pending.map(function(t){ return t.id; }).join("、")});
  }
  return rec;
}
var VERDICT_TEXT = {clean:"干净", fixed:"已修", open:"有遗留"};
function batchLabel(rec, k){
  if(!rec) return "";
  return "已收口 " + (rec.date || "—") + " · " + (VERDICT_TEXT[rec.verdict] || rec.verdict || "—") +
    (wrapupGateSkipped(k, rec) ? " · 闸门已跳过" : "");
}
/* 纯函数：只依赖任务数据与 handoff 配置，不读 progress、不读 batchRecords——导出用。
   口吻与密度照 buildBugAll，不带架构段 */
function batchPrompt(k){
  var BL = batchLayers(), g = BL.by[k] || [], N = k + 1, mods = DT.modules || [];
  if(!g.length) return "";
  var ids = g.map(function(t){ return t.id; });
  var slug = "batch-" + N, wt = "../" + HREPO + "-" + slug, plans = "../.codex-plans/" + HREPO + "-" + slug + "/";
  var br = "batch/" + N + "-<YYYYMMDD>", rec = HDOCS + "/_run/batches/batch-" + N + "-<YYYYMMDD>.md";
  var fe = g.some(function(t){ return isFrontend(t.module); }), judg = g.some(hasJudgments);
  var L = [];
  L.push("# 第 " + N + " 批收口：批次小结 · 测试 · 查 bug");
  L.push("");
  L.push("本批 " + g.length + " 个任务已全部落地（" + ids.join("、") + "）。单任务审查各看各的一层，看不见任务之间的接缝；" +
         "这一步把整批当整体验一遍，并给下一批留一份小结。假设一定有 bug，去证明它错；证明不了才算干净。");
  L.push("");
  L.push("本会话无人值守：权限已经全给你了，不要停下来要授权、要确认，也不要以提问收尾。" +
         "提示词与仓库现状对不上时先列选项交 Jev 裁决，把结果写进回报的「自行裁决」段；只有授权红线才问用户。");
  L.push("");
  L.push("## 项目");
  L.push("- 项目：" + D.project + (HO.stack ? "　｜　技术栈：" + HO.stack : "") + "　｜　主干：" + HMAIN);
  L.push("- 开发文档：" + HDOCS + "。知识库入口 " + HDOCS + "/_MOC.md；每个任务的代码位置在 图谱/任务/<任务ID>.md，先读它再开文件。");
  L.push("");
  L.push("## 本批任务");
  var seen = {};
  mods.forEach(function(m){
    var ts = g.filter(function(t){ return t.module === m.id; });
    if(!ts.length) return;
    L.push("- " + m.id + "　" + m.role);
    ts.forEach(function(t){
      seen[t.id] = 1;
      L.push("  - " + t.id + "　" + t.title + ((t.edges||[]).length ? "　边界 " + t.edges.join("、") : ""));
    });
  });
  g.forEach(function(t){
    if(!seen[t.id]) L.push("- " + t.id + "　" + t.title + "（模块 " + t.module + "）");
  });
  var prev = [];
  for(var i = 0; i < k; i++) (BL.by[i] || []).forEach(function(t){ prev.push(t.id); });
  if(prev.length){
    L.push("");
    L.push("## 前置批次");
    L.push("第 1..." + k + " 批共 " + prev.length + " 个任务：" + prev.join("、"));
    L.push("接缝往前查一层：本批与它们的接口（调用、共享类型、读写同一份数据）；不重审前置本身。");
  }
  var bm = {};
  g.forEach(function(t){ bm[t.module] = 1; });
  var ms = (DT.milestones || []).filter(function(m){
    return (m.modules || []).some(function(x){ return bm[x]; }) && String(m.demo || "").trim();
  });
  if(ms.length){
    L.push("");
    L.push("## 对照里程碑（只作参照，不是本批的验收）");
    ms.forEach(function(m){ L.push("- " + m.name + "（" + (m.modules||[]).join("、") + "）：结束时可演示 — " + m.demo); });
  }
  L.push("");
  L.push("## 逐任务复核清单（每条都要指到 文件:行）");
  g.forEach(function(t){
    L.push("");
    L.push("### " + t.id + "　" + t.title);
    L.push("验收标准：");
    acceptLines(t.accept).forEach(function(x){ L.push("- " + x); });
    L.push("边界：");
    L.push(edgeBlock(t.edges));
  });
  L.push("");
  L.push("## 怎么做");
  L.push("0. 工作目录。先 git worktree list 看自己在哪：");
  L.push("   - 在主检出（列表第一行）→ 别的会话可能也在这里切分支，先开自己的：git fetch origin " + HMAIN +
         " && git worktree add -b " + br + " " + wt + " origin/" + HMAIN + "，然后 cd 进去（分支已存在就去掉 -b；目录已存在就直接进）。<YYYYMMDD> 换成今天的日期。");
  L.push("   - 已在某个工作树里 → 就地：git fetch origin " + HMAIN + " && git checkout -b " + br + " origin/" + HMAIN + "（分支已存在就 git checkout " + br + "）");
  L.push("   进去后先装依赖，node_modules 这类不跟工作树走；planning 一类工作文件放仓库外的 " + plans + "，别放仓库根目录。之后所有命令都在这个目录里跑。");
  L.push("   本次只允许这两个仓库外目录：工作树 " + wt + " 与 planning " + plans + "。不许 git clone 一份仓库，不许自造别的目录。" +
         "Windows 侧绝不跑 git worktree prune——WSL 建的活工作树在 Windows 显示 prunable，prune 会打断正在干活的会话。");
  L.push("   建栈：git config rerere.enabled true && git config remote.pushDefault origin && gh stack init --base " + HMAIN + " " + br);
  L.push("1. 先跑现有全部测试与 lint（命令在 17-测试策略；没写就 TESTS 记 skipped 并写明原因、NOT_FIXED 记一条 doc-issue，不猜命令）。红的先记下来，别顺手修——它可能就是线索。");
  L.push("   跑 17 节的端到端冒烟：真起服务、真浏览器打开首页、断言样式已加载（token 类的 computed style 生效）、走一遍主流程；没有这条冒烟就记 NOT_FIXED 标 doc-issue。");
  if(judg) L.push("   本批含判断层任务：跑 17 节的判断用例集并做一次真实调用（TYPESAFE_API_KEY 未设置就 TESTS 记 skipped 并写明原因，不用录制应答冒充）；核每个问题只有一个归属任务、ID 与 10 节语义判断契约一致。");
  L.push("2. 逐任务在 " + HMAIN + " 上过一遍上面的复核清单：每条验收标准、每条边界指到 文件:行；指不到的就是 bug。");
  L.push("3. 查五类接缝，范围限本批内部与本批对前置批次的接口：");
  L.push("   1) 模块之间的调用：A 产出的字段、错误码、枚举、时间格式、精度，B 读的时候是不是同一套。判据是 10-接口约定。");
  L.push("   2) 同一条边界被两个任务各兜一半：13 节里「模块」列和实现它的任务不在同一模块的边界，两边是不是都做了、有没有做成两套。");
  L.push("   3) 共用约定（06 节）的执行：错误体系、环境变量、共享类型，有没有哪个模块自己另立一套。");
  L.push("   4) 跨任务的状态与并发：一个任务写、另一个任务读的表或缓存，读到的是不是权威来源；两个入口同时改一条记录会怎样。");
  L.push("   5) 主流程端到端跑一遍（09 节 UX 主路径 + 12 节时序图）中本批覆盖的段：起真实服务，不 mock；每个失败分支都走一次。");
  L.push("   TypeSafe 复核（可选）：对本批每个任务，把它的验收标准与它引用的边界忠实翻成英文写成 state 跑 python \"" + HDOCS + "/_run/typesafe_ask.py\" --log \"" + HDOCS + "/_run/judgments.jsonl\" run coverage --state <文件>；covered_E-XX 为 no 的边界优先人工复核；skipped 照常继续。");
  L.push("4. 找到 bug 先写复现再修，只改根因不重构；每个修复配一个修复前失败、修复后通过的测试。根因在前置批次代码里的也修，条目标「跨批」；" +
         "根因在文档的记进 NOT_FIXED 标「doc-issue」，不改开发文档。能在本次安全修复的就提交 fix(<任务ID>): <现象>；仍不通过、未修、修复失败或需要独立范围的每个问题，都必须按下面 TASKS 格式登记为新任务，不能只写 NOT_FIXED。" +
         "收工前调 dsh-pre-push-checks 按本次改动挑最小充分测试集跑一遍。");
  L.push(jevAdjudication("batch-" + N + ":wrapup"));
  L.push("5. 写记录文件 " + rec + "（模板见下，<YYYYMMDD> 与分支同一个日期）→ python " + HDOCS + "/_run/build_docs.py " + HDOCS + " --batches。" +
         "若有返工任务，--batches 会完整构建，打印新 R<批>-T<编号> 并生成任务笔记、dispatch.json、index.html；运行 git status --short，" +
         "git add -- " + rec + " " + HDOCS + "/docs-data.js " + HDOCS + "/_run/build-manifest.json " +
         HDOCS + "/_run/dispatch.json " + HDOCS + "/_run/review.json " + HDOCS + "/index.html <本次新 R-ID 的图谱/任务/*.md> 与修复的文件（不用 git add -A，核对后只加实际改动的文件）" +
         " → git commit -m \"第 " + N + " 批收口小结\" → gh stack push && gh stack submit --auto --open。没有修复也要提 PR：记录文件本身就要进仓库。");
  L.push("6. PR 按审查提示词的方式核了再合：gh stack view --json 只有这一个 → gh pr merge <号> --merge；等它报 MERGED。" +
         "合并后清理：gh pr list --state open --base " + br + " --json number --jq length 是 0 才删；git worktree remove " + wt +
         "（node_modules 报 not empty 就 rm -rf " + wt + "）→ git branch -d " + br + " → rm -rf " + plans + "。主检出 git pull 后刷新交接台，该批标题会显示「已收口」。");
  L.push("");
  L.push("## 记录文件模板（七个业务字段 + repair_schema 一个不少；有遗留时追加 task 围栏）");
  L.push("```markdown");
  L.push("---");
  L.push("batch: " + N);
  L.push("tasks: " + ids.join(", "));
  L.push("date: <YYYY-MM-DD>");
  L.push("verdict: <clean | fixed | open>");
  L.push("tests: <pass | fail | skipped>");
  L.push("skip_reason: <只在 tests 为 skipped 且 verdict 为 clean/fixed 时写，说明为何无测试仍可收口（如纯文档批次）；其余情况删掉这行>");
  L.push("pr: <PR 链接或 none>");
  L.push("note: <给下一批的一句提醒，可空>");
  L.push("repair_schema: 1");
  L.push("---");
  L.push("");
  L.push("## 交付了什么");
  L.push("本批 " + g.length + " 个任务各做成了什么，合起来能演示什么。");
  L.push("");
  L.push("## 测试");
  L.push("跑了哪些命令、结果；skipped 写原因。");
  L.push("");
  L.push("## 发现与修复");
  L.push("每条 bug 一行：编号、严重级、涉及任务、根因、修复提交。");
  L.push("");
  L.push("## 遗留");
  L.push("没修的与为什么；没有写 none。");
  L.push("");
  L.push("## 返工任务");
  L.push("verdict=open 时，每个未通过的已复现 bug / 问题写一个 `task` 围栏，字段必须齐全；同一问题重跑收口沿用 stable-key，--batches 会去重并保留已做状态：");
  L.push("```task");
  L.push("stable-key: <稳定短键，如 api-timeout-retry；同一问题永不改>");
  L.push("title: <动作 + 可观察结果>");
  L.push("module: <M1>");
  L.push("source-tasks: <M1-T1, M1-T2>");
  L.push("depends-on: <M1-T1, M1-T2；通常是涉及的原任务>");
  L.push("input: <复现、证据、相关原任务与接口>");
  L.push("output: <要改的仓库相对路径或产物>");
  L.push("acceptance: <编号化、可判真假的验收；含回归测试与真实入口证据>");
  L.push("edges: <E-01, E-02；没有写 none>");
  L.push("paths: <仓库相对路径，逗号分隔；不得通配>");
  L.push("estimate: <0.5d|1d|1.5d|2d>");
  L.push("severity: <S1|S2|S3>");
  L.push("jev: <本问题最终 Jev line/model/option；无普通裁决写 none>");
  L.push("```");
  L.push("");
  L.push("## 给下一批的提醒");
  L.push("接口、约定、坑：下一批开工前该知道的一两句。");
  L.push("```");
  L.push("");
  L.push("## 要用的技能（时机 — 拿到什么）");
  L.push("- `gh-stack`　建分支、push、submit 时 — 每条命令的非交互标志；不带 --json/--auto 会卡死在全屏 TUI 且不报错");
  L.push("- `dsh-code-review`　查接缝时 — 接口两侧契约、生命周期与并发、绕过校验的入口；不调会放过「每条都做了但合起来是错的」");
  L.push("- `dsh-pre-push-checks`　收工前 — 按 outgoing diff 挑最小充分证据集；不许 --passWithNoTests、不许裸 --force");
  L.push("- `dsh-merging-stacked-prs`　合并时 — 先认单 PR 情形（base 是主干、没人叠在上面 → 普通 gh pr merge）；等 MERGED、零依赖才删分支");
  if(judg) L.push("- `typesafe-ai`　核判断层接缝时 — 问题归属、criteria 兜底、阈值来源、低置信分支；真实调用的 model 记录才是证据");
  if(fe){
    L.push("- `record-browser-gif`　端到端跑主流程时 — 从真实服务录 GIF 作证据，等待条件用 DOM 状态不用固定延时");
    L.push("- `finesse-ui`　看界面时 — 只用 audit 只读命令：组件八态、对比度与焦点顺序、偷懒默认、手机六类硬伤");
  }
  L.push("");
  L.push("## 输出格式（严格遵守，BUGS 与 NOT_FIXED 的条目格式下游要机器解析）");
  L.push("BATCH_SUMMARY");
  L.push("- 本批合起来交付了什么，三五句");
  L.push("TESTS");
  L.push("- pass | fail | skipped → 跑的命令与结果；skipped 写原因");
  L.push("BUGS");
  L.push("- B1 [S1 数据错或丢、权限能绕 | S2 功能错 | S3 体验与边角] 涉及 <任务ID>（跨批时加「跨批」）：现象 → 复现 → 根因 → 文件:行");
  L.push("  没有写 none，并列出跑过的用例——没有证据的「没找到」不算");
  L.push("FIXED");
  L.push("- B1 → commit <hash>：改了什么、加了哪个测试");
  L.push("NOT_FIXED");
  L.push("- B2 [S1|S2|S3] 涉及 <任务ID>（跨批时加「跨批」）：现象 → 复现 → 根因 → 文件:行 → 为什么不修（doc-issue / Jev red_line / Jev 暂不可用 / 牵动太大）；每条必须在 TASKS 有同一 stable-key 的新任务");
  L.push("TASKS");
  L.push("- <stable-key> → <title> → source-tasks → paths → acceptance；没有遗留写 none");
  L.push("SUSPECT");
  L.push("- 怀疑但没复现的；没有写 none");
  L.push("RECORD");
  L.push("- 记录文件路径 → verdict → --batches 输出的那行");
  L.push("NEXT");
  L.push("- 一行给用户：「收口 PR 已提：<链接>，按审查方式核了再合；合并后 git pull 刷新交接台」");
  L.push("");
  L.push("「自行裁决」一段：逐条写冲突、全部候选、Jev line/model/option 与动作；没有写「无」。普通技术或 UI/UX 选择不得交给用户。");
  return L.join("\n");
}

function promptFor(kind, id){
  if(kind === "kick") return buildKickoff();
  if(kind === "bugall") return buildBugAll();
  if(kind === "batch"){
    var k = parseInt(id, 10);
    if(isNaN(k) || !batchComplete(k)) return "";
    var rs = batchRecordsOf(k), head = "";
    if(rs.length){
      var last = rs[rs.length - 1];
      head = "上次收口 " + (last.date || "—") + " · " + (last.verdict || "—") + "，本次是第 " + (rs.length + 1) + " 轮。\n\n";
    }
    return head + batchPrompt(k);
  }
  var t = taskById(id);
  if(!t) return "";
  if(kind === "impl" && implLocked(id)) return "";
  if(kind === "resume") return buildResume(t);
  if(kind === "impl") return buildImpl(t);
  if(kind === "review") return progressOf(id) === "todo" ? buildContractReview(t) : buildReview(t);
  if(kind === "bug") return buildBug(t);
  return "";
}

C.metrics = function(){
  var t = DT.tasks||[], m = DT.modules||[], e = DT.edges||[], r = DT.risks||[];
  var days = t.reduce(function(s,x){ return s + (x.est||0); }, 0);
  var covered = e.filter(function(x){
    return t.some(function(k){ return (k.edges||[]).indexOf(x.id) >= 0; });
  }).length;
  var rate = e.length ? Math.round(100*covered/e.length) : null;
  var cells = [
    [m.length, "模块"], [t.length, "任务"],
    [(Math.round(days*10)/10) + " 人天", "工作量合计"],
    [e.length, "边界情况"],
    [rate == null ? "—" : rate + "%", "边界被任务覆盖", rate === 100 ? "ok" : (rate != null && rate < 80 ? "bad" : "")],
    [r.length, "已登记风险"]
  ];
  return '<div class="mx">' + cells.map(function(c){
    return '<div><b'+(c[2]?' class="'+c[2]+'"':'')+'>'+esc(c[0])+"</b><span>"+esc(c[1])+"</span></div>";
  }).join("") + "</div>";
};

C.modulemap = function(){
  var mods = DT.modules||[], tasks = DT.tasks||[];
  if(!mods.length) return "";
  var ids = mods.map(function(m){ return m.id; });
  var lv = layerOf(ids, function(id){
    var m = mods.filter(function(x){ return x.id===id; })[0];
    return (m && m.deps) || [];
  });
  var items = mods.map(function(m){
    var mine = tasks.filter(function(t){ return t.module === m.id; });
    var d = mine.reduce(function(s,x){ return s + (x.est||0); }, 0);
    return {id: m.id, line1: cut(m.role.split(/[：:]/)[0], 13), layer: lv[m.id],
            line2: mine.length + "任务·" + (Math.round(d*10)/10) + "d", deps: m.deps||[]};
  });
  return '<div class="pane">' + svgNodes(items, {w:172, h:44, hiKind:"modules"}) + "</div>" +
    '<div class="legend"><span>箭头方向即依赖方向，左边的必须先做完</span></div>';
};

C.taskdag = function(){
  var tasks = DT.tasks||[];
  if(!tasks.length) return "";
  var ids = tasks.map(function(t){ return t.id; });
  var lv = layerOf(ids, function(id){
    var t = tasks.filter(function(x){ return x.id===id; })[0];
    return (t && t.deps) || [];
  });
  var cp = critical(tasks);
  var items = tasks.map(function(t){
    return {id: t.id, line1: cut(t.title.replace(/（.*$/, ""), 11), line2: t.est ? t.est + "d" : "",
            layer: lv[t.id], deps: t.deps||[]};
  });
  var first = tasks.filter(function(t){ return lv[t.id] === 0; }).length;
  return '<div class="pane">' + svgNodes(items, {w:150, h:42, crit: cp.path, hiKind:"tasks"}) + "</div>" +
    '<div class="legend"><span><i class="crit"></i>关键路径 ' + cp.path.length + ' 个任务共 ' +
    (Math.round(cp.total*10)/10) + ' 人天，它决定最短工期</span>' +
    '<span><i></i>最左一层 ' + first + ' 个任务无前置依赖，可立即并行开工</span>' +
    '<span>点节点看任务详情</span></div>';
};

C.edgematrix = function(){
  var edges = DT.edges||[], tasks = DT.tasks||[];
  if(!edges.length || !tasks.length) return "";
  var head = '<tr><th class="rw"></th>' + tasks.map(function(t){
    return "<th>" + esc(t.id) + "</th>"; }).join("") + '<th class="cnt">覆盖</th></tr>';
  var rows = edges.map(function(e){
    var hits = tasks.map(function(t){ return (t.edges||[]).indexOf(e.id) >= 0; });
    var n = hits.filter(Boolean).length;
    return '<tr class="' + (n ? "" : "miss") + '"><th class="rw">' + esc(e.id) + "</th>" +
      hits.map(function(h){ return "<td>" + (h ? "<i></i>" : "") + "</td>"; }).join("") +
      '<td class="cnt">' + (n ? n + " 个任务" : "未覆盖") + "</td></tr>";
  });
  var miss = edges.filter(function(e){
    return !tasks.some(function(t){ return (t.edges||[]).indexOf(e.id) >= 0; }); }).length;
  return '<div class="pane"><table class="emx">' + head + rows.join("") + "</table></div>" +
    '<div class="legend"><span>行是边界情况，列是任务。实心点表示该任务的验收标准写明了这条边界</span>' +
    (miss ? '<span style="color:var(--fail)">' + miss + " 条边界没有任何任务兜底</span>"
          : "<span>全部 " + edges.length + " 条边界都有任务兜底</span>") + "</div>";
};

C.milestones = function(){
  var ms = DT.milestones||[], tasks = DT.tasks||[];
  if(!ms.length) return "";
  return '<div class="lanes">' + ms.map(function(m){
    var mods = (m.modules||[]).map(function(x){ return '<button class="chip">' + esc(x) + "</button>"; }).join(" ");
    var d = m.days;
    if(!d){
      var sum = tasks.filter(function(t){ return (m.modules||[]).indexOf(t.module) >= 0; })
                     .reduce(function(s,x){ return s + (x.est||0); }, 0);
      d = Math.round(sum*10)/10;
    }
    return '<div class="lane"><div class="nm">' + esc(m.name) + "</div>" +
      '<div class="bar"><div class="mods">' + mods + '<span class="d">' + esc(d) + " 人天</span></div>" +
      '<div class="demo">' + esc(m.demo||"") + "</div></div></div>";
  }).join("") + "</div>";
};

C.risks = function(){
  var rs = DT.risks||[];
  if(!rs.length) return "";
  return '<div class="risks">' + rs.map(function(r){
    return '<div class="risk"><b>' + esc(r.risk) + "</b><dl>" +
      "<dt>影响</dt><dd>" + esc(r.impact) + "</dd>" +
      "<dt>缓解</dt><dd>" + esc(r.mitigation) + "</dd>" +
      "<dt>触发</dt><dd>" + esc(r.trigger) + "</dd></dl></div>";
  }).join("") + "</div>";
};

C.terms = function(){
  var ts = DT.terms||[];
  if(!ts.length) return "";
  return '<div class="terms">' + ts.map(function(t){
    return '<div class="term"><b>' + esc(t.term) + "</b>" +
      (t.code ? "<code>" + esc(t.code) + "</code>" : "") +
      "<p>" + esc(t.meaning) + "</p></div>";
  }).join("") + "</div>";
};

C.endpoints = function(){
  var es = DT.endpoints||[];
  if(!es.length) return "";
  return '<div class="tw"><table><thead><tr><th>方法</th><th>路径</th><th>入参</th><th>返回</th><th>权限</th></tr></thead><tbody>' +
    es.map(function(e){
      return "<tr><td>" + esc(e.method) + "</td><td><code>" + esc(e.path) + "</code></td><td>" +
        esc(e.params) + "</td><td>" + esc(e.ret) + "</td><td>" + esc(e.auth) + "</td></tr>";
    }).join("") + "</tbody></table></div>";
};

/* ══════════════════════════════════════════════════
   演进与决策：这个项目是怎么一步步定下来的。
   主干是 23 节的版本，决策按 23 节末列的序号挂到对应版本下。
   被驳回的问题和低置信的决策必须一眼看见——前者说明当初理解有偏差，
   后者是交付后最该复核的那批。埋在一张八列表格里等于没写。
   ══════════════════════════════════════════════════ */
function dnum(s){
  var m = String(s||"").match(/(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
  return m ? (+m[1])*10000 + (+m[2])*100 + (+m[3]) : 0;
}

function decCard(d){
  var cls = "dec" + (d.review === "flawed" ? " flawed" : "") + (d.conf === "low" ? " low" : "");
  var h = '<li class="' + cls + '"><div class="dh">' +
    '<span class="dn">D' + d.n + "</span>" +
    '<span class="dq">' + esc(d.q || "—") + "</span>";
  if(d.review === "flawed")
    h += '<span class="tag st">✗ 问题被驳回</span>';
  else if(d.review === "incomplete")
    h += '<span class="tag st">信息不足</span>';
  if(d.conf === "low") h += '<span class="tag cf">低置信 · 该复核</span>';
  h += "</div>";
  if(d.choice)
    h += '<p class="pick">选定 <b>' + esc(d.choice) + "</b>" +
      (/counter/i.test(d.choice) ? "　（采纳了代理用户的反提案，不是原来给的选项）" : "") + "</p>";
  if(d.why) h += '<p class="why">' + esc(d.why) + "</p>";
  if(d.edges && d.edges.length)
    h += '<p class="why">引入边界　' + d.edges.join(" ") + "</p>";
  if(d.assume && !/^(none|无|—|-)$/i.test(d.assume.trim()))
    h += '<p class="why">隐含假设　' + esc(d.assume) + "</p>";
  return h + "</li>";
}

C.evolution = function(){
  var ds = (DT.decisions||[]).slice(), cs = (DT.changes||[]).slice();
  if(!ds.length && !cs.length) return "";
  var byN = {};
  ds.forEach(function(d){ byN[d.n] = d; });

  /* 变更记录常见两种写法：首版在最上（正序）或最新在最上（倒序）。
     没被任何版本认领的决策要兜到「首版」那一个节点，兜错了整条时间线就反了 */
  var claimed = {};
  cs.forEach(function(c){ (c.decs||[]).forEach(function(n){ claimed[n] = 1; }); });
  var base = 0;
  if(cs.length > 1){
    var a = dnum(cs[0].date), b = dnum(cs[cs.length-1].date);
    if(a && b && a > b) base = cs.length - 1;
  }
  var orphan = ds.filter(function(d){ return !claimed[d.n]; });

  var nodes = cs.length ? cs : [{ver: "首版", date: "", what: "文档成稿", why: "", decs: []}];
  var h = "";
  nodes.forEach(function(c, i){
    var mine = (c.decs||[]).map(function(n){ return byN[n]; }).filter(Boolean);
    if(i === base) mine = orphan.concat(mine);
    mine.sort(function(x, y){ return x.n - y.n; });
    h += '<div class="ver"><h5><span class="vn">' + esc(c.ver || "—") + "</span>" +
      "<span>" + esc(c.what || "") + "</span>" +
      (c.date ? '<span class="vd">' + esc(c.date) + "</span>" : "") + "</h5>";
    if(c.why && !/^(—|-|无)$/.test(c.why.trim()))
      h += "<p><span class=\"k\">因为</span>" + esc(c.why) + "</p>";
    if(mine.length)
      h += '<ul class="decs">' + mine.map(decCard).join("") + "</ul>";
    else if(cs.length && i !== base)
      h += '<div class="none">这一版没有新的决策记录。</div>';
    h += "</div>";
  });

  var flawed = ds.filter(function(d){ return d.review === "flawed"; }).length;
  var low = ds.filter(function(d){ return d.conf === "low"; }).length;
  var stat = "决策 " + ds.length + " 条";
  if(flawed) stat += "　被驳回 " + flawed + " 条（当初的问题不成立，走的是反提案）";
  if(low) stat += "　低置信 " + low + " 条（交付后优先复核这些）";
  if(!flawed && !low && ds.length) stat += "　全部成立且高置信";

  return '<div class="evo">' + h + "</div>" +
    '<div class="legend"><span>' + esc(stat) + "</span>" +
    (ds.length ? "<span>决策里的 E-XX 可以点开看边界定义</span>" : "") +
    (cs.length ? "" : "<span>23 节还没有变更记录，全部决策挂在首版下</span>") + "</div>";
};


function handBody(){
  var tasks = DT.tasks || [];
  var BL = batchLayers(), lv = BL.lv, by = BL.by;

  var done = tasks.filter(function(t){ return isLanded(t.id); }).length;
  /* 进行中和审查中都算「在跑」：分支都还没进主干，下游都还得等。已落地·待复验不在其中 */
  var doing = tasks.filter(function(t){ return stOf(t.id) === "doing" || stOf(t.id) === "review"; });
  var recheck = tasks.filter(function(t){ return stOf(t.id) === "recheck"; });
  var next = dispatchable();
  var nextIds = {};
  next.forEach(function(t){ nextIds[t.id] = 1; });

  var say;
  if(done === tasks.length){
    say = "<b>全部 " + tasks.length + " 个任务已落地。</b>";
  } else if(next.length){
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　现在可以同时开 <b>" + next.length +
          "</b> 个会话并行做：<em>" + next.map(function(t){ return t.id; }).join("　") + "</em>" +
          (next.length > 1 ? "　（这几个互不依赖，也不抢同一批文件；一个任务一个会话，提示词会让每个会话先给自己开 worktree，别让它们共用一个检出）" : "");
  } else if(doing.length){
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　" + doing.length +
          " 个还没落地（<em>" + doing.map(function(t){ return t.id; }).join("　") +
          "</em>）。剩下的都等着它们：审查方落地时会记录（--landed），刷新本页后按前置与收口闸门解锁下游；没记录的手点状态标签。";
  } else {
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　当前没有可派任务：检查前置是否都已落地、" +
          (HO.wrapupGate !== false ? "紧邻上一批是否已收口、" : "") + "文档补丁是否还在同步、任务要求有没有明确错误（点该行「审查」看原因），或存在依赖循环。";
  }
  if(recheck.length){
    say += "　<b>" + recheck.length + "</b> 个已落地任务待复验：<em>" + recheck.map(function(t){ return t.id; }).join("　") +
           "</em>，点该行「审查」得到复验提示词；它们仍算已落地，不锁下游。";
  }
  say += wrapupNotice();

  var h = '<div class="kick">' +
    '<button class="cp big" data-kind="kick">复制开工总提示词</button>' +
    "<p>先把这条发给写代码的模型，一次性交代文档位置、技术栈、分支规矩和开工顺序。" +
    "之后按下面的顺序派活：复制「实施」发过去（状态自动推到进行中），它交活后复制同一行的「审查」做验收" +
    "（自动推到审查中）；审查判 pass 落地时会把「已落地」记进任务笔记，刷新本页后按前置与收口闸门解锁下游，没记录的手点状态标签。" +
    "「查 bug」是独立一步，不改状态：某一层落地前想再扫一遍、或一批任务落地后想查跨模块的接缝，点它。</p>" +
    '<button class="cp big bug" data-kind="bugall" title="查已落地任务之间的接缝：接口两侧、共用约定、跨任务状态">查全项目 bug</button></div>' +
    '<div class="hnow"><span class="bar"><i style="width:' +
      (tasks.length ? Math.round(100 * done / tasks.length) : 0) + '%"></i></span>' +
      '<span class="txt">' + say + "</span>" +
      '<button class="rs" data-act="reset">重置进度</button></div>';

  var openMap = batchOpenMap();
  Object.keys(by).map(Number).sort(function(a, b){ return a - b; }).forEach(function(k){
    var g = by[k];
    var d = Math.round(g.reduce(function(s, x){ return s + (x.est||0); }, 0) * 10) / 10;
    var gd = g.filter(function(t){ return isLanded(t.id); }).length;
    var gDoing = g.filter(function(t){ return stOf(t.id) === "doing"; }).length;
    var gReview = g.filter(function(t){ return stOf(t.id) === "review"; }).length;
    var full = batchComplete(k), rec = full ? batchRecord(k) : null;
    var notLanded = g.filter(function(t){ return !isLanded(t.id); }).map(function(t){ return t.id; });
    /* 默认开合：在跑或可派的批展开，全落地的折叠，其余折叠；用户点过的以本机记录为准 */
    var isOpen = openMap[String(k)] != null ? !!openMap[String(k)]
      : (gDoing + gReview > 0 || g.some(function(t){ return nextIds[t.id]; }));
    var cnt = [];
    if(gd) cnt.push("已落地 " + gd + "/" + g.length);
    if(gDoing) cnt.push("进行中 " + gDoing);
    if(gReview) cnt.push("审查中 " + gReview);
    h += '<div class="hbatch' + (isOpen ? " open" : "") + '" data-batch="' + k + '"><h5>' +
         '<span class="tg" data-act="batchtoggle" data-batch="' + k + '" title="点一下折叠或展开这一批"><span class="tri">' + (isOpen ? "▾" : "▸") + "</span>" +
         "第 " + (k+1) + " 批 · " + g.length + " 个任务 · " + d + " 人天 · " +
         (k === 0 ? "无前置依赖，可立即开工" : (HO.wrapupGate !== false ? "前置全部落地后可开始；紧邻上一批落齐时须收口；同批次其他任务在跑不影响" : "前置全部落地后可开始；同批次其他任务在跑不影响")) +
         (rec ? " · " + esc(batchLabel(rec, k)) : full ? " · 可收口" : "") + "</span>" +
         (cnt.length ? '<span class="cnt">' + cnt.join(" · ") + "</span>" : "") +
         '<button class="cp batch" data-kind="batch" data-batch="' + k + '"' +
         (full ? ' title="' + (rec ? "再收口一次：把整批重新验一遍，记录文件新开一份" : "复制收口提示词：整批做小结、跑测试、查批内与跨批接缝，写记录并走一条 PR") + '"'
               : ' disabled title="还有 ' + notLanded.length + ' 个未落地：' + esc(notLanded.join("、")) + '"') +
         ">" + (rec ? "再收口一次" : "批次收口") + "</button></h5>" +
         '<div class="hbody"' + (isOpen ? "" : " hidden") + ">";
    g.forEach(function(t){
      var id = esc(t.id), st = stOf(t.id), wait = waitingOn(t);
      var rv = rivalsOf(t.id).filter(function(x){
        return lv[x.id] === k && !isLanded(x.id);
      });
      var cls = "htask " + st + (nextIds[t.id] ? " now" : "");
      h += '<div class="' + cls + '" data-t="' + id + '">' +
        (fileLanded(t.id)
          ? '<button class="st" disabled title="审查方落地时记进了任务笔记（status: done）与 _run/progress.js；要撤销就把笔记的 status 改回 todo 再重跑 build_docs.py">'
          : '<button class="st" data-act="st" title="点一下推进一格：待派 → 进行中 → 审查中 → 已落地（已落地再点会退回待派，会先问一句）">') +
          ST_TEXT[st] + "</button>" +
        '<span class="hid"><button class="chip" data-id="' + id + '">' + id + "</button></span>" +
        '<span class="htt">' + esc(t.title) + "</span>";
      if(rv.length){
        var one = clashOf(t.id, rv[0].id);
        var brief = one.length > 20 ? "…" + one.slice(-18) : one;
        h += '<span class="cls" title="' + esc(rv.map(function(x){ return x.id; }).join("、")) +
             " 也会改 " + esc(one) + '，别和它们同时派">✕ 抢 ' + esc(brief) + "</span>";
      }
      if(st === "todo" && wait.length)
        h += '<span class="wait">等 ' + esc(wait.join("、")) + "</span>";
      h += '<span class="hd">' + (t.est ? t.est + "d" : "—") + "</span>" +
        '<button class="cp" data-kind="impl" data-task="' + id + '"' +
          (implLocked(t.id) ? ' disabled title="' + esc(implLockTitle(t.id)).replace(/"/g, "&quot;") + '"' : "") + ">实施</button>" +
        '<button class="cp" data-kind="review" data-task="' + id + '"' + (st === "recheck" ? ' title="已落地任务被文档补丁标为待复验：复制复验提示词，核对后 verify 并 --landed 清除标记"' : '') + '>审查</button>' +
        ((st === "doing" || st === "review" || st === "recheck") ? '<button class="cp" data-kind="resume" data-task="' + id + '" title="' + (st === "recheck" ? "继续复验：沿用本次复验的工作树与 PR（若有）" : "沿用原分支和 PR，只处理补丁与返工条目") + '">续做</button>' : '') +
        '<button class="cp bug" data-kind="bug" data-task="' + id + '" title="不改状态，随时可点">查 bug</button></div>';
    });
    h += "</div></div>";
  });
  var repairs = tasks.filter(function(t){ return t.repair; });
  if(repairs.length){
    h += '<div class="hbatch open repair" data-batch="repair"><h5><span class="tg"><span class="tri">▾</span>' +
         '批次收口返工 · ' + repairs.length + ' 个未落地任务 · 来自 open 收口记录</span></h5><div class="hbody">';
    repairs.forEach(function(t){
      var id = esc(t.id), st = stOf(t.id), wait = waitingOn(t);
      h += '<div class="htask ' + st + (nextIds[t.id] ? ' now' : '') + '" data-t="' + id + '">' +
        (fileLanded(t.id) ? '<button class="st" disabled title="已记录落地">' : '<button class="st" data-act="st">') +
        ST_TEXT[st] + '</button><span class="hid"><button class="chip" data-id="' + id + '">' + id + '</button></span>' +
        '<span class="htt">' + esc(t.title) + ' <small>第 ' + esc(t.sourceBatch) + ' 批 · ' + esc(t.severity || '') + '</small></span>' +
        (st === 'todo' && wait.length ? '<span class="wait">等 ' + esc(wait.join('、')) + '</span>' : '') +
        '<span class="hd">' + (t.est ? t.est + 'd' : '—') + '</span>' +
        '<button class="cp" data-kind="impl" data-task="' + id + '"' + (implLocked(t.id) ? ' disabled title="' + esc(implLockTitle(t.id)).replace(/"/g, '&quot;') + '"' : '') + '>实施</button>' +
        '<button class="cp" data-kind="review" data-task="' + id + '">审查</button>' +
        ((st === 'doing' || st === 'review') ? '<button class="cp" data-kind="resume" data-task="' + id + '">续做</button>' : '') +
        '<button class="cp bug" data-kind="bug" data-task="' + id + '">查 bug</button></div>';
    });
    h += '</div></div>';
  }
  return h;
}

/* ── 并行窗口调度的渲染 ── */
function swimSvg(plan, N){
  var PAD = 78, TOP = 24, RH = 32, GAP = 9;
  var span = Math.max(plan.span, 1);
  /* 每人天的像素宽随总工期自适应：工期短就拉开，长就压紧，
     总宽控制在一屏能横向滚完的范围 */
  var PXD = Math.max(38, Math.min(120, Math.round(760 / span)));
  var W = PAD + span * PXD + 24, H = TOP + N * (RH + GAP) + 16;
  var cp = critical(DT.tasks || []);
  var o = [];

  /* 时间刻度：0.5 天一格太密，按 1 天走；工期超过 12 天改 2 天一格 */
  var step = span > 12 ? 2 : 1;
  for(var d = 0; d <= Math.ceil(span); d += step){
    var x = PAD + d * PXD;
    o.push('<line class="swgrid" x1="'+x+'" y1="'+(TOP-6)+'" x2="'+x+'" y2="'+(H-12)+'"/>');
    o.push('<text class="swtick" x="'+(x+3)+'" y="'+(TOP-10)+'">'+d+"d</text>");
  }

  for(var l = 0; l < N; l++){
    var y = TOP + l * (RH + GAP);
    o.push('<text class="swlane" x="0" y="'+(y+RH/2+4)+'">窗口 '+(l+1)+"</text>");
    plan.lanes[l].forEach(function(r){
      var x0 = PAD + r.start * PXD, w = Math.max(26, (r.end - r.start) * PXD - 3);
      var crit = cp.path.indexOf(r.id) >= 0;
      var cls = "swbox" + (crit ? " crit" : "") +
                (r.st === "doing" ? " doing" : r.st === "review" ? " review" : "");
      o.push('<g data-node="'+esc(r.id)+'">' +
        '<rect class="'+cls+'" x="'+x0+'" y="'+y+'" width="'+w+'" height="'+RH+'" rx="4"><title>' +
          esc(r.id + "　" + r.task.title + "\n" + r.start + "d → " + r.end + "d" +
              (r.wait.indexOf("clash:") === 0
                 ? "\n被 " + r.wait.slice(6) + " 占着同一批文件，只能等它做完"
                 : (r.wait === "dep" && r.depFrom ? "\n等前置 " + r.depFrom + " 落地" : ""))) +
          "</title></rect>" +
        '<text class="swid'+(crit?" crit":"")+'" x="'+(x0+7)+'" y="'+(y+14)+'">'+esc(r.id)+"</text>");
      if(w > 76){
        /* 按实际字宽裁，不按字符数——中文一个字顶两个西文，
           按字符数裁会让中文标题溢出块外压到隔壁 */
        var tt = r.task.title.replace(/（.*$/, ""), room = w - 14;
        if(textW(tt, 9.5) > room){
          while(tt.length > 1 && textW(tt + "…", 9.5) > room) tt = tt.slice(0, -1);
          tt += "…";
        }
        o.push('<text class="swtt" x="'+(x0+7)+'" y="'+(y+26)+'">' + esc(tt) + "</text>");
      }
      o.push("</g>");
      /* 被抢文件推迟的，从挡路那一块画一条虚线过来——不标出来，
         看图的人会以为这段空窗是排程没排满 */
      if(r.wait.indexOf("clash:") === 0){
        var from = null;
        plan.placed.forEach(function(p){ if(p.id === r.wait.slice(6)) from = p; });
        if(from){
          var fy = TOP + from.lane * (RH + GAP) + RH/2;
          o.push('<path class="swgap" d="M'+(PAD+from.end*PXD)+' '+fy+'L'+x0+' '+(y+RH/2)+'"/>');
        }
      }
    });
  }
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+o.join("")+"</svg>";
}

function swimBody(){
  var tasks = DT.tasks || [];
  if(!tasks.length) return "";
  var N = laneCount(), plan = planLanes(N);
  var left = tasks.length - plan.merged.length;

  var say;
  if(!left){
    say = "<b>全部 " + tasks.length + " 个任务已落地</b>，没有要排的了。";
  } else {
    var cut1 = plan.serial > 0 ? Math.round(100 * (1 - plan.span / plan.serial)) : 0;
    say = "剩下 <b>" + left + "</b> 个任务排进 <b>" + N + "</b> 个窗口，最快 <em>" +
      plan.span + " 人天</em> 走完" +
      (plan.serial > plan.span
        ? "；一个人串行做要 " + plan.serial + " 人天，省掉 " + cut1 + "%"
        : "");
    if(plan.blocked.length)
      say += "。<b style=\"color:var(--fail)\">" + plan.blocked.length +
        " 个排不进去</b>（" + plan.blocked.map(function(t){ return t.id; }).join("、") +
        "），依赖多半成环了";
  }

  var nb = "";
  for(var i = 1; i <= 6; i++)
    nb += '<button class="nb' + (i === N ? " on" : "") + '" data-act="lanes" data-n="' + i + '">' + i + "</button>";

  var h = '<div class="swim"><div class="swimtop"><span class="txt">' + say + "</span>" +
    '<span class="swimn">窗口数 ' + nb + "</span></div>" +
    '<div class="swimbox">' + swimSvg(plan, N) + "</div>";

  /* 真开 N 个窗口时，一个窗口发一条序列。没有这个，「窗口分工」还是要人自己抄 */
  h += '<div class="swimcp">';
  for(var l = 0; l < N; l++){
    var rs = plan.lanes[l];
    if(!rs.length){ continue; }
    var d = Math.round(rs.reduce(function(s, r){ return s + (r.end - r.start); }, 0) * 10) / 10;
    h += '<button data-act="lanecopy" data-lane="' + l + '">' +
      '<span class="w">窗口 ' + (l+1) + "</span>" +
      '<span class="s">' + esc(rs.map(function(r){ return r.id; }).join(" → ")) + "</span>" +
      '<span class="w" style="text-align:right">' + d + "d ⧉</span></button>";
  }
  h += "</div></div>";
  return h;
}

function laneSeqText(l){
  var N = laneCount(), plan = planLanes(N), rs = plan.lanes[l] || [];
  var L = ["# " + D.project + "　窗口 " + (l+1) + " 的任务序列", ""];
  L.push("这个窗口按下面的顺序做，一次一个。每个任务的完整提示词在阅读器交接台里复制。");
  L.push("");
  L.push("开工前先给这个窗口开一个独立工作目录，免得几个窗口在同一个目录里互相切分支：");
  L.push("   git fetch origin " + HMAIN + " && git worktree add --detach " + hTree(l+1) + " origin/" + HMAIN);
  L.push("   cd " + hTree(l+1));
  L.push("窗口内部换任务不用再开工作树：每个任务提示词的第 0 步看到你已在工作树里，会就地从最新 " + HMAIN + " 建分支。");
  L.push("");
  rs.forEach(function(r, i){
    L.push((i+1) + ". " + r.id + "　" + r.task.title +
           "　（" + (r.task.est || "?") + "d，第 " + r.start + " → " + r.end + " 人天）");
    var w = [];
    (r.task.deps||[]).forEach(function(d){ w.push(d); });
    if(w.length) L.push("   前置：" + w.join("、") + " 必须先落地");
    if(r.wait.indexOf("clash:") === 0)
      L.push("   注意：和 " + r.wait.slice(6) + " 会改同一批文件，必须等它做完再开始");
  });
  if(!rs.length) L.push("（这个窗口这一轮没有任务，减少窗口数）");
  L.push("");
  L.push("总计 " + rs.length + " 个任务、" +
         Math.round(rs.reduce(function(s, r){ return s + (r.end - r.start); }, 0)*10)/10 + " 人天。");
  L.push("别去做别的窗口的任务——它们正在并行开发，撞上就是合并冲突。");
  return L.join("\n");
}

C.schedule = function(){
  if(!(DT.tasks||[]).length) return "";
  var tip = TP && Object.keys(TP).length
    ? "抢同一批文件的任务不会被排进重叠时段，虚线标出是谁挡的"
    : "补上 handoff.taskPaths，排程才能连「两个任务抢同一个文件」一起躲开";
  return '<div id="swimbox">' + swimBody() + "</div>" +
    '<div class="legend"><span>一条 lane 就是一个会话窗口，横轴是人天</span>' +
    "<span><i class=\"crit\"></i>关键路径上的任务</span>" +
    "<span>" + tip + "</span>" +
    "<span>已落地的任务不再占窗口，推进度后整张表重排</span></div>";
};


/* 交接台在概览页只留一张入口卡。真正的整页在侧边栏里（见 renderHandoff）。
   保留这个组件是为了向后兼容：存量 presentation.json 里的 {"type":"handoff"}
   不用改就仍然有效，note 照旧显示，只是不再占概览页一大片 */
C.handoff = function(){
  if(!(DT.tasks||[]).length) return "";
  var tasks = DT.tasks, done = tasks.filter(function(t){ return isLanded(t.id); }).length;
  var next = dispatchable();
  var say;
  if(done === tasks.length) say = "<b>全部 " + tasks.length + " 个任务已落地。</b>";
  else if(next.length)
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　现在可以同时开 <b>" +
          next.length + "</b> 个会话并行做：<em>" +
          next.slice(0, 5).map(function(t){ return t.id; }).join("　") +
          (next.length > 5 ? " …" : "") + "</em>";
  else
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　其余任务在等前置落地、" +
          (HO.wrapupGate !== false ? "紧邻上一批收口、" : "") + "文档补丁同步或任务要求的明确错误修正，点对应批次标题或「审查」看原因。";
  say += wrapupNotice();
  return '<div class="hentry" id="hentry"><span class="bar"><i style="width:' +
    (tasks.length ? Math.round(100*done/tasks.length) : 0) + '%"></i></span>' +
    '<span class="txt">' + say + "</span>" +
    '<button class="cp big" data-act="gohand">打开任务交接台 →</button></div>';
};

/* 交接台整页：侧边栏点进来的那一页。顺序是先看怎么分窗口，再拿提示词派活 */
function renderHandoff(){
  var tasks = DT.tasks || [];
  var h = '<div class="eyebrow"><span class="num">⚡</span><span>派活</span></div>' +
          '<div class="doc hpage"><h1>任务交接台</h1>';
  if(!tasks.length){
    h += '<p class="hhint">19 节没抽到任务表，交接台没东西可派。' +
         "检查那一节的表格列序是不是 8 列：ID | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估。</p></div>";
    return h;
  }
  h += '<p class="hhint">每个任务三个按钮：「实施」复制给写代码的模型，它交活后「审查」复制给验收的模型，' +
       "「查 bug」复制给专门找 bug 的模型（不改状态，随时可点）。审查只跑一轮清单就必须给结论：" +
       "只有阻断项才打回，最多打回两轮，之后由审查方自己修完落地。提示词是自包含的——任务卡全字段、" +
       "依赖任务标题、涉及的每条边界定义都已内联，对方不翻文档也能开工。</p>";

  var sw = C.schedule();
  if(sw){
    h += '<section class="blk"><h2>并行窗口调度<span class="k">LANES</span></h2>' +
      '<p class="note">一条 lane 就是一个真开出来的会话窗口。排程同时受两条约束：' +
      "依赖层级管「谁必须等谁」，taskPaths 管「谁和谁会改同一个文件」——" +
      "后者依赖图完全看不见，只有排在这里才躲得开。</p>" + sw + "</section>";
  }
  h += '<section class="blk"><h2>按批次派活<span class="k">HANDOFF</span></h2>' +
    '<p class="note">批次按依赖层级自动算出，同一批内互不依赖。' +
    "状态四格：待派 → 进行中 → 审查中 → 已落地。「实施」「审查」复制成功会自动推前两格；" +
    "最后一格由审查方落地时用 build_docs.py --landed 记录，刷新即见；没记录才手点状态标签。" +
    "每推一格，上面的窗口调度和下面的可派集合一起重算。</p>" +
    C.handbatch() + "</section></div>";
  return h;
}

C.handbatch = function(){
  if(!(DT.tasks||[]).length) return "";
  var tip = TP && Object.keys(TP).length
    ? "标了 ✕ 的两个任务会改到同一批文件，别同时派"
    : "想让它连文件冲突也一起防，在 presentation.json 里补 handoff.taskPaths";
  return '<div class="hand" id="handbox">' + handBody() + "</div>" +
    '<div class="legend"><span>批次按依赖层级自动算出，同一批内互不依赖</span>' +
    "<span>状态：待派 → 进行中 → 审查中 → 已落地；「实施」「审查」自动推前两格，「已落地」由 --landed 记录、刷新即见，没记录才手点</span>" +
    "<span>批次收口：一批全部落地后可点；默认锁紧邻下一批，复制不改状态</span>" +
    "<span>" + tip + "</span>" +
    "<span>进度存在本机浏览器里，换机器要重新标</span></div>";
};

/* 状态一变，能并发派的集合和窗口排程都跟着变，整块重画最省事也最不容易出错。
   重画后要补 chipify，否则「等 M1-T3」里的编号会从可点芯片退化成纯文本 */
function refreshHand(){
  var box = document.getElementById("handbox");
  if(box){ box.innerHTML = handBody(); chipify(box); }
  var sw = document.getElementById("swimbox");
  if(sw){ sw.innerHTML = swimBody(); }
  var he = document.getElementById("hentry");
  if(he){
    var wrap = he.parentNode, tmp = document.createElement("div");
    tmp.innerHTML = C.handoff();
    if(tmp.firstChild) wrap.replaceChild(tmp.firstChild, he);
  }
  navBadge();
}

C.html = function(b){ return b.html || ""; };

var TITLES = {
  metrics:["规模一览","SCALE"], modulemap:["模块地图与依赖方向","ARCHITECTURE"],
  taskdag:["任务依赖与开工顺序","SEQUENCE"], edgematrix:["边界覆盖矩阵","COVERAGE"],
  milestones:["交付批次","MILESTONES"], risks:["风险看板","RISKS"],
  terms:["术语速查","GLOSSARY"], endpoints:["接口速查","API"],
  evolution:["演进与决策","EVOLUTION"], schedule:["并行窗口调度","LANES"],
  handoff:["派活","HANDOFF"], html:["",""]
};

function renderOverview(){
  var blocks = PR.blocks;
  if(!blocks || !blocks.length){
    blocks = ["metrics","modulemap","taskdag","edgematrix","milestones","risks","evolution","handoff"]
      .map(function(t){ return {type:t}; });
  }
  var h = '<div class="eyebrow"><span class="num">00</span><span>概览</span></div>' +
          '<div class="doc"><h1>' + esc(D.project) + "</h1>";
  if(PR.lead) h += '<div class="lead">' + md(PR.lead).replace(/^<p>|<\/p>$/g, "") + "</div>";
  blocks.forEach(function(b){
    var fn = C[b.type]; if(!fn) return;
    var body = fn(b); if(!body) return;
    var ti = b.title || (TITLES[b.type]||["",""])[0], kk = (TITLES[b.type]||["",""])[1];
    h += '<section class="blk">' +
      (ti ? "<h2>" + esc(ti) + (kk ? '<span class="k">' + kk + "</span>" : "") + "</h2>" : "") +
      (b.note ? '<p class="note">' + esc(b.note) + "</p>" : "") + body + "</section>";
  });
  h += "</div>";
  return h;
}

/* ── 导航与渲染 ── */
var app = document.getElementById("app"), tree = document.getElementById("tree"),
    q = document.getElementById("q"), hits = document.getElementById("hits");

document.getElementById("proj").textContent = D.project || "开发文档";
document.getElementById("gen").textContent = D.generated ? "生成于 " + D.generated : "";
(function(){
  var r = D.review, el = document.getElementById("rev");
  if(!r){ el.innerHTML = '<i class="dot"></i><span>未审查</span>'; return; }
  var ok = r.block === 0 && r.current;
  var ready = Object.keys(HC.readiness || {}).filter(function(id){ return !contractPending(id); }).length;
  el.className = "badge " + (ok ? "pass" : "fail");
  el.innerHTML = '<i class="dot"></i><span><b>' + (ok ? "结构检查通过" : (r.current ? r.block + " 项待修" : "检查结果已过期")) +
    "</b>　任务契约已复核 " + ready + "/" + (DT.tasks || []).length + "</span>";
})();

var ovBtn = document.createElement("button");
ovBtn.className = "nav top-item"; ovBtn.dataset.i = "-1";
ovBtn.innerHTML = '<span class="n">00</span><span class="t">概览</span>';
ovBtn.onclick = function(){ open(-1); if(innerWidth<=900) document.body.classList.remove("nav-open"); };
tree.appendChild(ovBtn);

/* 交接台是侧边栏里的一等入口，不是概览页最底下那一块——派活是高频操作，
   每次翻到底再找它不合理。角标显示实时进度，不用点进去也知道剩多少 */
var handBtn = null;
if((DT.tasks||[]).length){
  handBtn = document.createElement("button");
  handBtn.className = "nav top-item"; handBtn.dataset.i = "-2";
  handBtn.title = "按 H 也能过来";
  handBtn.onclick = function(){ open(-2); if(innerWidth<=900) document.body.classList.remove("nav-open"); };
  tree.appendChild(handBtn);
  var sep = document.createElement("div"); sep.className = "navsep";
  tree.appendChild(sep);
}
function navBadge(){
  if(!handBtn) return;
  var tasks = DT.tasks || [];
  var done = tasks.filter(function(t){ return isLanded(t.id); }).length;
  var all = done === tasks.length;
  handBtn.innerHTML = '<span class="n">⚡</span><span class="t">任务交接台</span>' +
    '<span class="c' + (all ? " all" : "") + '">' + done + "/" + tasks.length + "</span>";
}
navBadge();

D.groups.forEach(function(g){
  var box = document.createElement("div"); box.className = "grp";
  box.innerHTML = "<h4>" + esc(g.name.replace(/^\d+-/, "")) + "</h4>";
  g.docs.forEach(function(d){
    var b = document.createElement("button");
    b.className = "nav"; b.dataset.i = docs.indexOf(d);
    b.innerHTML = '<span class="n">' + esc(d.num) + '</span><span class="t">' + esc(d.title) + "</span>" +
      (d.count ? '<span class="c">' + d.count + "</span>" : "");
    b.onclick = function(){ open(+b.dataset.i); if(innerWidth<=900) document.body.classList.remove("nav-open"); };
    box.appendChild(b);
  });
  tree.appendChild(box);
});

/* i 有三种：-1 概览、-2 任务交接台、>=0 正文第 i 节 */
function open(i, noHash){
  var key;
  if(i === -2){
    app.innerHTML = renderHandoff(); key = "交接台";
  } else if(i < 0){
    app.innerHTML = renderOverview(); key = "概览";
  } else {
    var d = docs[i];
    app.innerHTML = '<div class="eyebrow"><span class="num">' + esc(d.num) + "</span><span>" +
      esc(d.group.replace(/^\d+-/,"")) + '</span></div><div class="doc"><h1>' + esc(d.title) + "</h1>" +
      md(d.md) + "</div>";
    var pager = document.createElement("div"); pager.className = "pager";
    pager.innerHTML = '<button data-g="' + (i-1) + '"><span class="k">上一节</span>' +
      esc(i > 0 ? docs[i-1].title : "概览") + "</button>";
    if(i < docs.length-1) pager.innerHTML += '<button class="r" data-g="' + (i+1) +
      '"><span class="k">下一节</span>' + esc(docs[i+1].title) + "</button>";
    pager.querySelectorAll("button").forEach(function(b){ b.onclick = function(){ open(+b.dataset.g); }; });
    app.appendChild(pager);
    key = d.num + "-" + d.title;
  }
  chipify(app); sortable(app); fitTables(app);
  document.querySelectorAll(".nav").forEach(function(n){ n.classList.toggle("on", +n.dataset.i === i); });
  if(!noHash){ try{ location.hash = encodeURIComponent(key); }catch(e){} }
  window.scrollTo(0,0); card.hidden = true;
}

/* ── 搜索：正文之外，任务、边界、接口、模块、术语、风险都能直接搜到 ──
   客户问「退款怎么处理」时，要能一步指到具体任务和边界，而不是只跳到某一章 */
var byNum = {};
docs.forEach(function(d, i){ byNum[parseInt(d.num, 10)] = i; });

function hl(s, v){
  return esc(String(s||"")).replace(
    new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"),
    function(m){ return "<mark>" + m + "</mark>"; });
}
function hitBtn(kind, key, title, sub, v){
  return '<button class="hit" data-kind="' + kind + '" data-key="' + esc(key) + '">' +
    "<b>" + hl(title, v) + "</b><span>" + hl(sub, v) + "</span></button>";
}

function runSearch(v){
  var low = v.toLowerCase();
  var any = function(){
    for(var i = 0; i < arguments.length; i++)
      if(String(arguments[i]||"").toLowerCase().indexOf(low) >= 0) return true;
    return false;
  };
  var out = [], total = 0;
  var grp = function(label, items, render){
    if(!items.length) return;
    total += items.length;
    out.push('<div class="hgrp"><h6><span>' + label + "</span><span>" + items.length + "</span></h6>" +
      items.slice(0, 6).map(render).join("") +
      (items.length > 6 ? '<div class="more">还有 ' + (items.length - 6) + " 条，再说具体些</div>" : "") +
      "</div>");
  };

  grp("任务", (DT.tasks||[]).filter(function(t){
    return any(t.id, t.title, t.accept, t.input, t.output, t.module);
  }), function(t){
    return hitBtn("task", t.id, t.id + "　" + t.title,
      (t.est ? t.est + "d · " : "") + (t.accept || ""), v);
  });

  grp("边界情况", (DT.edges||[]).filter(function(e){
    return any(e.id, e.scene, e.trigger, e.expect, e.module);
  }), function(e){
    return hitBtn("edge", e.id, e.id + "　" + e.scene,
      "触发 " + e.trigger + "　期望 " + e.expect, v);
  });

  grp("接口", (DT.endpoints||[]).filter(function(x){
    return any(x.method, x.path, x.params, x.ret, x.auth);
  }), function(x){
    return hitBtn("sec", "10", x.method + " " + x.path,
      "返回 " + x.ret + "　权限 " + x.auth, v);
  });

  grp("模块", (DT.modules||[]).filter(function(m){ return any(m.id, m.role); }), function(m){
    return hitBtn("sec", "6", m.id + "　" + m.role,
      (m.deps||[]).length ? "依赖 " + m.deps.join("、") : "无依赖", v);
  });

  grp("术语", (DT.terms||[]).filter(function(t){ return any(t.term, t.meaning, t.code); }),
    function(t){
      return hitBtn("sec", "3", t.term + (t.code ? "　" + t.code : ""), t.meaning, v);
    });

  grp("风险", (DT.risks||[]).filter(function(r){
    return any(r.risk, r.impact, r.mitigation, r.trigger);
  }), function(r){
    return hitBtn("sec", "21", r.risk, "缓解 " + r.mitigation, v);
  });

  grp("正文", docs.filter(function(d){ return any(d.md, d.title); }), function(d){
    var pos = d.md.toLowerCase().indexOf(low);
    var s = pos < 0 ? d.md.slice(0, 90) : d.md.slice(Math.max(0, pos - 42), pos + 78);
    return hitBtn("doc", String(docs.indexOf(d)), d.num + " " + d.title, s, v);
  });

  hits.innerHTML = total ? out.join("")
    : '<div class="none">没搜到「' + esc(v) + "」。换个说法，或者试编号（E-03、M2-T1）、接口路径、术语。</div>";
}

q.addEventListener("input", function(){
  var v = q.value.trim();
  if(!v){ hits.hidden = true; tree.hidden = false; return; }
  tree.hidden = true; hits.hidden = false;
  runSearch(v);
});

hits.addEventListener("click", function(ev){
  var b = ev.target.closest(".hit");
  if(!b) return;
  var k = b.dataset.kind, key = b.dataset.key;
  if(k === "doc"){
    open(+key);
    if(innerWidth <= 900) document.body.classList.remove("nav-open");
  } else if(k === "sec"){
    var i = byNum[parseInt(key, 10)];
    if(i != null) open(i);
    if(innerWidth <= 900) document.body.classList.remove("nav-open");
  } else {
    /* 任务和边界直接就地弹定义卡，讲解时不用离开搜索结果 */
    showCard(b, key);
  }
  ev.stopPropagation();  /* 否则全局 click 会把刚弹出来的卡片又关掉 */
});

document.getElementById("menu").onclick = function(){ document.body.classList.toggle("nav-open"); };
/* 卡片是按触发元素的位置算的绝对定位，窗口一改尺寸就错位；
   留着不但没用，在变窄时还会把整页撑出横向滚动条 */
window.addEventListener("resize", function(){ fitTables(app); card.hidden = true; });
document.getElementById("print").onclick = function(){
  var pa = document.getElementById("printall");
  if(!pa.innerHTML){
    pa.innerHTML = '<div class="doc">' + renderOverview() + "</div>" + docs.map(function(d){
      return '<div class="doc"><h1>' + esc(d.num + " " + d.title) + "</h1>" + md(d.md) + "</div>";
    }).join("");
  }
  window.print();
};

/* ── 启动与路由 ── */
function routeTo(hash, noHash){
  var want = decodeURIComponent(String(hash||"").replace(/^#/, ""));
  var i = docs.findIndex(function(d){ return (d.num + "-" + d.title) === want; });
  if(i >= 0) open(i, noHash);
  else if(want === "交接台" && handBtn) open(-2, noHash);
  else open(-1, noHash);
}
/* 前进后退要能用。三个视图之间来回切是高频动作，
   浏览器按钮点了没反应比没有按钮更让人困惑 */
window.addEventListener("hashchange", function(){ routeTo(location.hash, true); });
routeTo(location.hash, true);
})();
</script>
</body>
</html>
"""


# ---------- 解析 ----------

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def tables(text):
    """抽出所有表格（已去掉分隔行）"""
    out, cur = [], []
    for ln in text.split("\n"):
        s = ln.strip()
        if s.startswith("|"):
            cs = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cs if c):
                continue
            cur.append(cs)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def rows_by_id(text, pat):
    return [r for tb in tables(text) for r in tb if r and re.fullmatch(pat, r[0])]


def first_table(text, min_cols):
    """第一张够宽的表，去掉表头行"""
    for tb in tables(text):
        if len(tb) > 1 and len(tb[0]) >= min_cols:
            return tb[1:]
    return []


def cell(r, i):
    return r[i].strip() if len(r) > i else ""


def strip_h1(text):
    """去掉文件开头的一级标题——阅读器会自己渲染标题，留着会重复显示"""
    lines = text.split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and re.match(r"^#\s+\S", lines[i]):
        del lines[i]
    return "\n".join(lines).strip()


def collect(root):
    """扫出分组与各节文档，同时按节号建索引"""
    groups, by_num = [], {}
    names = [d for d in sorted(os.listdir(root))
             if os.path.isdir(os.path.join(root, d)) and not d.startswith("_")]
    names.sort(key=lambda n: (GROUP_ORDER.index(n) if n in GROUP_ORDER else 99, n))
    for g in names:
        gd = os.path.join(root, g)
        files = sorted(f for f in os.listdir(gd) if f.endswith(".md"))
        if not files:
            continue
        docs = []
        for f in files:
            m = re.match(r"^(\d{1,2})[-_.]?\s*(.+)\.md$", f)
            num = m.group(1).zfill(2) if m else ""
            title = (m.group(2) if m else f[:-3]).strip()
            text = strip_h1(read(os.path.join(gd, f)))
            if m:
                by_num[int(m.group(1))] = text
            d = {"num": num, "title": title, "path": g + "/" + f, "md": text}
            n = len(rows_by_id(text, r"E-\d{1,3}")) or len(rows_by_id(text, r"M\d{1,2}-T\d{1,3}"))
            if n:
                d["count"] = n
            docs.append(d)
        groups.append({"name": g, "docs": docs})
    return groups, by_num


def est_days(s):
    m = re.search(r"(\d+(?:\.\d+)?)\s*[dD天]", s or "")
    return float(m.group(1)) if m else 0.0


def norm_review(s):
    """代理用户的 QUESTION_REVIEW 归一化。中英文写法都收，认不出的按 sound 处理——
    「问题成立」是常态，误判成 flawed 会在时间线上凭空标一片红"""
    v = (s or "").strip().lower()
    if "flaw" in v or "counter" in v or "驳回" in v or "不成立" in v or "有问题" in v:
        return "flawed"
    if "incomplete" in v or "不全" in v or "信息不足" in v or "待补" in v:
        return "incomplete"
    return "sound"


def norm_conf(s):
    """CONFIDENCE 归一化。认不出按 high——低置信要进复核清单，宁可漏标不可错标"""
    v = (s or "").strip().lower()
    if v.startswith("l") or "低" in v:
        return "low"
    if v.startswith("m") or "中" in v:
        return "medium"
    return "high"


def dec_refs(s):
    """23 节末列的「涉及决策」→ 决策序号列表。收 13 / 1-12 / 1,3,5 / D7 几种写法"""
    out = []
    for part in re.split(r"[,，、\s]+", (s or "").strip()):
        if not part:
            continue
        m = re.fullmatch(r"[Dd]?(\d{1,3})\s*[-–~～至到]\s*[Dd]?(\d{1,3})", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            out.extend(range(min(a, b), max(a, b) + 1))
            continue
        m = re.fullmatch(r"[Dd]?(\d{1,3})", part)
        if m:
            out.append(int(m.group(1)))
    return sorted(set(out))


def extract(by_num):
    """把文档表格转成结构化数据——组件渲染的唯一输入"""
    t3, t6 = by_num.get(3, ""), by_num.get(6, "")
    t10, t13 = by_num.get(10, ""), by_num.get(13, "")
    t19, t20, t21 = by_num.get(19, ""), by_num.get(20, ""), by_num.get(21, "")
    t22, t23 = by_num.get(22, ""), by_num.get(23, "")

    modules = [{"id": cell(r, 0), "role": cell(r, 1),
                "deps": re.findall(r"\bM\d{1,2}\b", cell(r, 2))}
               for r in rows_by_id(t6, r"M\d{1,2}")]

    # 输入/产出（第 4、5 列）只有任务提示词用得上，图表不看
    tasks = [{"id": cell(r, 0), "title": cell(r, 1), "module": cell(r, 2),
              "deps": re.findall(r"(?:M\d{1,2}-T\d{1,3}|R\d{1,3}-T\d{1,8})", cell(r, 3)),
              "input": cell(r, 4), "output": cell(r, 5),
              "accept": cell(r, 6), "est": est_days(cell(r, 7)),
              "edges": sorted(set(re.findall(r"E-\d{1,3}", cell(r, 6))))}
             for r in rows_by_id(t19, r"M\d{1,2}-T\d{1,3}")]

    edges = [{"id": cell(r, 0), "scene": cell(r, 1), "trigger": cell(r, 2),
              "expect": cell(r, 3), "module": cell(r, 4)}
             for r in rows_by_id(t13, r"E-\d{1,3}")]

    milestones = [{"name": cell(r, 0), "modules": re.findall(r"\bM\d{1,2}\b", cell(r, 1)),
                   "days": cell(r, 2), "demo": cell(r, 3)}
                  for r in rows_by_id(t20, r"(第.{1,3}批|B\d+)")]

    risks = [{"risk": cell(r, 0), "impact": cell(r, 1),
              "mitigation": cell(r, 2), "trigger": cell(r, 3)}
             for r in first_table(t21, 4)]

    terms = [{"term": cell(r, 0), "meaning": cell(r, 1), "code": cell(r, 2)}
             for r in first_table(t3, 2)]

    def raw_tables(text):
        out, current = [], []
        for line in text.splitlines():
            if line.strip().startswith("|"):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                    current.append((cells, line))
            elif current:
                out.append(current)
                current = []
        if current:
            out.append(current)
        return out

    entity_table = next((tb for tb in raw_tables(by_num.get(9, ""))
                         if len(tb) > 1 and len(tb[0][0]) >= 3), [])
    entities = [{"name": cell(r, 0), "fields": cell(r, 1), "raw": raw}
                for r, raw in entity_table[1:]]

    # 接口总表必须是 10 节第一张 4 列以上的表；字段级契约那类宽表只能排在它后面
    api_tables = raw_tables(t10)
    api_index = next((i for i, tb in enumerate(api_tables)
                      if len(tb) > 1 and len(tb[0][0]) >= 4), None)
    endpoints = []
    if api_index is not None:
        for r, raw in api_tables[api_index][1:]:
            if not re.fullmatch(r"(GET|POST|PUT|PATCH|DELETE)", cell(r, 0), re.I):
                continue
            path = cell(r, 1).strip("`")
            fields = [row for tb in api_tables[api_index + 1:] if len(tb[0][0]) >= 4
                      for cells, row in tb[1:]
                      if path in re.findall(r"/api/[\w/:.-]+", row)]
            endpoints.append({"method": cell(r, 0), "path": cell(r, 1), "params": cell(r, 2),
                              "ret": cell(r, 3), "auth": cell(r, 4),
                              "raw": raw, "fieldContracts": fields})

    # 22 节沿用 _run/decisions.md 的 8 列原样。首列是纯数字序号，用它筛掉说明性表格
    decisions = [{"n": int(cell(r, 0)), "q": cell(r, 1),
                  "review": norm_review(cell(r, 2)), "reviewRaw": cell(r, 2),
                  "choice": cell(r, 3), "why": cell(r, 4),
                  "edges": sorted(set(re.findall(r"E-\d{1,3}", cell(r, 5)))),
                  "assume": cell(r, 6),
                  "conf": norm_conf(cell(r, 7)), "confRaw": cell(r, 7)}
                 for r in rows_by_id(t22, r"\d{1,3}")]

    # 23 节的第 5 列「涉及决策」是可选的，缺了 decs 为空 → 该版本不挂决策，
    # 全部决策会由 evolution 组件兜到第一个版本下
    changes = [{"ver": cell(r, 0), "date": cell(r, 1), "what": cell(r, 2),
                "why": cell(r, 3), "decs": dec_refs(cell(r, 4))}
               for r in first_table(t23, 3) if cell(r, 0)]

    return {"modules": modules, "tasks": tasks, "edges": edges,
            "milestones": milestones, "risks": risks,
            "terms": terms, "endpoints": endpoints, "entities": entities,
            "decisions": decisions, "changes": changes}


def read_code_refs(root, tasks):
    """只读任务笔记的受保护代码块；空块与生成器的未回填占位不算代码位置。"""
    placeholders = {
        "_（**落地前必须回填**。一行一处，格式：`路径:行号` — 说明）_",
        "_（实施后回填。一行一处，格式：`路径:行号` — 说明）_",
    }
    for task in tasks:
        task["codeRefs"] = []
        path = os.path.join(root, "图谱", "任务", task["id"] + ".md")
        if not os.path.isfile(path):
            continue
        match = re.search(r"<!--\s*code:begin\s*-->(.*?)<!--\s*code:end\s*-->", read(path), re.S)
        if not match:
            continue
        lines = [line for line in match.group(1).splitlines() if line.strip()]
        if lines and re.fullmatch(r"\s*`{3,}[^`]*", lines[0]):
            lines.pop(0)
        if lines and re.fullmatch(r"\s*`{3,}\s*", lines[-1]):
            lines.pop()
        task["codeRefs"] = [line for line in lines if line.strip() not in placeholders][:40]


def chip_index(data):
    """芯片弹卡与图上节点点击用的查询表。
    modules 是给时序图/状态机图上的参与方用的——那里的参与方按约定写模块 ID，
    点了要能弹出职责，没有这张表就会显示「没找到这个编号的定义」"""
    tasks_of = {}
    for t in data["tasks"]:
        tasks_of.setdefault(t["module"], []).append(t["id"])
    return {
        "edges": {e["id"]: e for e in data["edges"]},
        "tasks": {t["id"]: {"title": t["title"], "module": t["module"],
                            "dep": "、".join(t["deps"]) or "无",
                            "accept": t["accept"], "est": (str(t["est"]) + "d") if t["est"] else ""}
                  for t in data["tasks"]},
        "modules": {m["id"]: {"role": m["role"],
                              "dep": "、".join(m["deps"]) or "无",
                              "tasks": tasks_of.get(m["id"], [])}
                    for m in data["modules"]},
    }


# ---------- 落地记录 ----------

ST_WORDS = {"done": ("done", "landed", "merged", "已落地", "已合并", "完成"),
            "review": ("review", "reviewing", "审查中"),
            "doing": ("doing", "wip", "进行中")}


def note_status(text):
    """任务笔记头部的 status 归一化成四格之一；认不出按 todo"""
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return None, None
    fm = m.group(1)
    i = re.search(r"^id:\s*(\S+)", fm, re.M)
    s = re.search(r"^status:\s*(\S+)", fm, re.M)
    if not i:
        return None, None
    v = (s.group(1) if s else "todo").strip().strip("\"'").lower()
    for k, words in ST_WORDS.items():
        if v in words:
            return i.group(1), k
    return i.group(1), "todo"


def js_payload(text, prefix):
    """把「window.X = {...};」这类一行赋值剥成 JSON 文本：去前缀、strip、末尾的分号切掉。
    不用 3.9 才有的字符串后缀方法——项目实施方在 WSL 里跑的是 Python 3.8"""
    body = text[len(prefix):] if text.startswith(prefix) else text
    body = body.strip()
    if body.endswith(";"):
        body = body[:-1]
    return body


def read_progress(root):
    """先取 docs-data.js 里随仓库走的 progress，再让本机 progress.js 覆盖；两者都只是笔记之外的兜底"""
    st = {}
    dp = os.path.join(root, "docs-data.js")
    if os.path.exists(dp):
        try:
            text = read(dp)
            st.update(json.loads(js_payload(text, "window.DOCS = ")).get("progress") or {})
        except (ValueError, AttributeError):
            pass
    p = os.path.join(root, "_run", "progress.js")
    if not os.path.exists(p):
        return st
    m = re.search(r"window\.PROGRESS\s*=\s*(\{.*?\});", read(p), re.S)
    try:
        st.update(json.loads(m.group(1)) if m else {})
    except ValueError:
        pass
    return st


def progress_state(root):
    """_run/progress.js 的内容：先取旧文件（知识库没建时它是唯一记录），再用任务笔记头部的 status 覆盖"""
    st = read_progress(root)
    d = os.path.join(root, "图谱", "任务")
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if not f.endswith(".md"):
                continue
            tid, s = note_status(read(os.path.join(d, f)))
            if tid:
                st[tid] = s
    return {k: v for k, v in st.items() if v != "todo"}


def write_progress(root, st):
    """阅读器用 <script src="_run/progress.js"> 加载它，与本机浏览器里点出来的进度合并。
    它是派生文件——每个检出目录各自生成，不进仓库，否则并行分支各改一行就冲突"""
    rd = os.path.join(root, "_run")
    if not os.path.isdir(rd):
        os.makedirs(rd)
    write_text(os.path.join(rd, "progress.js"),
               "// 任务历史状态；待复核/补丁标记优先于浏览器旧完成状态。\n"
               "window.PROGRESS = " + json.dumps(st, ensure_ascii=False, sort_keys=True) + ";\n")
    gi = os.path.join(rd, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w", encoding="utf-8", newline="\n") as f:
            f.write("# 派生文件，各检出目录各自生成，不进仓库\nprogress.js\n")


def prompt_compiler_core(progress, maintenance):
    """共享浏览器提示词函数；导出只补入本次历史进度与复验标记，不改派发字段。"""
    core = HTML[HTML.index("var HO = PR.handoff || {};"):HTML.index("C.metrics = function(){")]
    return ("window.PROGRESS = " + json.dumps(progress, ensure_ascii=False) + ";\n"
            + "window.MAINTENANCE = " + json.dumps(maintenance, ensure_ascii=False) + ";\n"
            + core)


def write_payload_key(root, key, value):
    """就地改写 docs-data.js 的一个顶层键（不重建）：progress 与 batchRecords 都走这里，随仓库进别的检出。
    它是构建清单里的产物，改完把清单里这一项的指纹同步更新，否则下一次 --landed 会被当成产物过期拒绝。
    返回 None 表示 docs-data.js 不存在或读不出来；False 表示值没变没写；True 表示写了"""
    p = os.path.join(root, "docs-data.js")
    if not os.path.exists(p):
        return None
    text = read(p)
    try:
        payload = json.loads(js_payload(text, "window.DOCS = "))
    except ValueError:
        return None
    if payload.get(key) == value:
        return False
    payload[key] = value
    new_text = "window.DOCS = " + json.dumps(payload, ensure_ascii=False) + ";\n"
    write_text(p, new_text)
    mp = os.path.join(root, "_run", "build-manifest.json")
    m = read_json(mp, {})
    if m and "docs-data.js" in (m.get("products") or {}):
        m["products"]["docs-data.js"] = digest(new_text)
        write_json(mp, m)
    return True


def write_progress_payload(root, st):
    """--landed 用：落地记录写进 docs-data.js 的 progress 键"""
    return bool(write_payload_key(root, "progress", st))


def task_layers(tasks):
    """交接台的「第 N 批」：{任务ID: 0 起层号}，层号 = 最长前驱链长度，有环就地截断。算法与 JS layerOf 相同"""
    ids = [t["id"] for t in tasks]
    deps = {t["id"]: list(t.get("deps") or []) for t in tasks}
    lv = {}

    def walk(tid, stack):
        if tid in lv:
            return lv[tid]
        if tid in stack:
            return 0
        m = 0
        for d in deps.get(tid, []):
            if d in deps:
                m = max(m, walk(d, stack + [tid]) + 1)
        lv[tid] = m
        return m

    for tid in ids:
        walk(tid, [])
    return lv


def read_batch_records(root):
    """扫 _run/batches/*.md 的 front matter → {文件名去 .md: {batch, tasks, date, verdict, tests, pr, note}}。
    目录不存在返回 {}；batch 不是整数的文件跳过。tasks 排序去重——阅读器与下游都按集合匹配本批"""
    d = os.path.join(root, "_run", "batches")
    if not os.path.isdir(d):
        return {}
    out = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith(".md"):
            continue
        m = re.match(r"^\ufeff?---\s*\n(.*?)\n---", read(os.path.join(d, f)), re.S)
        if not m:
            continue
        fm = {}
        for line in m.group(1).splitlines():
            mm = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
            if mm:
                fm[mm.group(1)] = mm.group(2).strip().strip("\"'")
        try:
            batch = int(fm.get("batch", ""))
        except ValueError:
            continue
        repair_schema = fm.get('repair_schema', '')
        if repair_schema not in ('', '1'):
            raise ValueError('%s 的 repair_schema 只支持 1' % f)
        tasks = sorted({x.strip() for x in re.split(r"[,，、\s]+", fm.get("tasks", "")) if x.strip()})
        text = read(os.path.join(d, f))
        repairs = parse_repair_tasks(text, f[:-3], batch)
        verdict = fm.get("verdict", "")
        if repairs and verdict != "open":
            raise ValueError('%s 含返工任务，verdict 须为 open；问题修完后写新的收口记录，不抹掉来源任务' % f)
        if verdict == "open" and (repair_schema == '1' or re.search(r'^##\s*返工任务\s*$', text, re.M)) and not repairs:
            raise ValueError('%s 的 verdict=open 但没有 ```task 返工任务；按新模板为每条遗留问题补齐稳定键、路径和验收' % f)
        if fm.get("tests") == "fail" and verdict in ("clean", "fixed"):
            raise ValueError('%s 的测试未通过，verdict 不能是 clean/fixed；登记 open 和返工任务' % f)
        if fm.get("tests") == "skipped" and verdict in ("clean", "fixed") and not fm.get("skip_reason"):
            raise ValueError('%s 的 tests 为 skipped 却判 clean/fixed；补跑测试，或在 front matter 写 skip_reason 说明为何无测试仍可收口' % f)
        out[f[:-3]] = {"batch": batch, "tasks": tasks, "date": fm.get("date", ""),
                       "verdict": fm.get("verdict", ""), "tests": fm.get("tests", ""),
                       "pr": fm.get("pr", ""), "note": fm.get("note", "")}
        if fm.get("skip_reason"):
            out[f[:-3]]["skipReason"] = fm.get("skip_reason")
        if repair_schema:
            out[f[:-3]]["repairSchema"] = int(repair_schema)
        if repairs:
            out[f[:-3]]["repairTasks"] = repairs
        elif verdict == "open":
            out[f[:-3]]["repairWarning"] = "旧版 open 记录没有返工任务；重收口并填写返工任务围栏后才能自动派发"
    groups = {}
    for name, record in out.items():
        groups.setdefault(tuple(record['tasks']), []).append((name, record))
    progress = None
    for records in groups.values():
        active, generation = {}, {}
        for name, record in sorted(records, key=lambda item: (str(item[1].get('date', '')), item[0])):
            for task in record.get('repairTasks', []):
                key = task['stableKey']
                episode = generation.get(key, 1)
                task['episode'] = episode
                task['id'] = active.get(key, {}).get('id') or repair_id(task['batch'], key, episode)
                active[key] = task
            if record.get('verdict') in ('clean', 'fixed'):
                if active:
                    if progress is None:
                        progress = progress_state(root)
                    pending = sorted(task['id'] for task in active.values() if progress.get(task['id']) != 'done')
                    if pending:
                        raise ValueError('%s 不得写 %s：上一轮的返工任务尚未落地：%s' %
                                         (name + '.md', record['verdict'], ', '.join(pending)))
                    for key in active:
                        generation[key] = generation.get(key, 1) + 1
                    active = {}
    return out


REPAIR_FIELDS = ('stable-key', 'title', 'module', 'source-tasks', 'depends-on', 'input', 'output',
                 'acceptance', 'edges', 'paths', 'estimate', 'severity', 'jev')


def split_list(value):
    return [x.strip() for x in re.split(r'[,，、\s]+', value or '') if x.strip() and x.strip().lower() != 'none']


def repair_id(batch, stable_key, episode=1):
    """一个未关闭周期内的 stable-key 映射稳定；修复关闭后同问题复发会得到新任务 ID。"""
    identity = stable_key.strip().lower() + '#%d' % episode
    token = int(hashlib.sha256(identity.encode('utf-8')).hexdigest()[:12], 16) % 100000000
    return 'R%d-T%08d' % (batch, token)


def parse_repair_tasks(text, record_name, batch):
    """解析收口记录里的 task 围栏。无遗留返回 []；坏围栏拒绝整次 --batches，避免静默丢任务。"""
    out, keys = [], set()
    for body in re.findall(r'```task\s*\n(.*?)\n```', text or '', re.S | re.I):
        values = {}
        for raw in body.splitlines():
            m = re.match(r'^([a-z][a-z-]*)\s*:\s*(.*)$', raw.strip(), re.I)
            if m:
                values[m.group(1).lower()] = m.group(2).strip()
        missing = [k for k in REPAIR_FIELDS if not values.get(k)]
        if missing:
            raise ValueError('%s 的返工任务缺字段：%s' % (record_name, ', '.join(missing)))
        key = values['stable-key'].lower()
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{2,79}', key):
            raise ValueError('%s 的 stable-key 非法：%s' % (record_name, values['stable-key']))
        if key in keys:
            raise ValueError('%s 重复 stable-key：%s' % (record_name, key))
        keys.add(key)
        paths = split_list(values['paths'])
        if not paths or any(not path_valid(p) for p in paths):
            raise ValueError('%s/%s 的 paths 须为无通配符的仓库相对路径' % (record_name, key))
        module = values['module']
        if not re.fullmatch(r'M\d{1,2}', module):
            raise ValueError('%s/%s 的 module 须为 M<n>' % (record_name, key))
        edges = split_list(values['edges'])
        if any(not re.fullmatch(r'E-\d{1,3}', e) for e in edges):
            raise ValueError('%s/%s 的 edges 须为 E-XX 或 none' % (record_name, key))
        source_tasks = split_list(values['source-tasks'])
        deps = split_list(values['depends-on'])
        if not source_tasks or not deps:
            raise ValueError('%s/%s 须列出来源任务与前置依赖' % (record_name, key))
        deps = sorted(set(deps) | set(source_tasks))
        if values['severity'].upper() not in ('S1', 'S2', 'S3'):
            raise ValueError('%s/%s 的 severity 须为 S1/S2/S3' % (record_name, key))
        if values['jev'].lower() != 'none' and not all(marker in values['jev'] for marker in ('model=', 'adopt=')):
            raise ValueError('%s/%s 的 jev 须为 none 或包含真实 model= 与 adopt= 证据' % (record_name, key))
        estimate = est_days(values['estimate'])
        if not estimate or estimate > 2:
            raise ValueError('%s/%s 的 estimate 须为 0.5d–2d' % (record_name, key))
        out.append({'id': repair_id(batch, key), 'stableKey': key, 'record': record_name,
                    'batch': batch, 'title': values['title'], 'module': module,
                    'sourceTasks': source_tasks, 'deps': deps,
                    'input': values['input'], 'output': values['output'], 'accept': values['acceptance'],
                    'edges': edges, 'paths': paths, 'est': estimate, 'severity': values['severity'].upper(),
                    'jev': values['jev']})
    return out


def collect_repair_tasks(records):
    """按 stable-key 去重：首次记录定义任务，后续同键仅确认仍待修，避免改写已复核契约。"""
    latest = {}
    origins = {}
    ordered = sorted(records.items(), key=lambda item: (str(item[1].get('date', '')), item[0]))
    for _, record in ordered:
        for task in record.get('repairTasks', []):
            key = (task['batch'], task['stableKey'], task.get('episode', 1))
            batch_tasks = tuple(record['tasks'])
            if key in origins and origins[key] != batch_tasks:
                raise ValueError('同一 stable-key/周期出现在不同任务集合的批次：%s' % task['stableKey'])
            origins[key] = batch_tasks
            if key in latest and latest[key]['id'] != task['id']:
                raise ValueError('返工任务 stable-key 映射不稳定：%s' % task['stableKey'])
            latest.setdefault(key, task)
    ids = {}
    for task in latest.values():
        identity = (task['stableKey'], task.get('episode', 1))
        if task['id'] in ids and ids[task['id']] != identity:
            raise ValueError('返工任务 ID 哈希冲突：%s' % task['id'])
        ids[task['id']] = identity
    return sorted(latest.values(), key=lambda task: task['id'])


def inject_repair_tasks(data, records):
    """覆盖层任务只进派发/契约数据，不改 19 节，也不参与原任务的批次分层。"""
    repairs = collect_repair_tasks(records)
    originals = {t['id'] for t in data['tasks']}
    modules = {m['id'] for m in data['modules']}
    edges = {e['id'] for e in data['edges']}
    layers = task_layers(data['tasks'])
    by_layer = {}
    for task_id, layer in layers.items():
        by_layer.setdefault(layer + 1, set()).add(task_id)
    repair_ids = {task['id'] for task in repairs}
    contracts = {}
    for task in repairs:
        if task['id'] in originals:
            raise ValueError('返工任务 ID 与 19 节冲突：' + task['id'])
        record = records[task['record']]
        if not set(task['sourceTasks']).issubset(set(record['tasks'])):
            raise ValueError('%s 的 source-tasks 不属于来源收口记录的任务集合' % task['id'])
        matches = [number for number, ids in by_layer.items() if ids == set(record['tasks'])]
        unknown = [d for d in task['deps'] if d not in originals and d not in repair_ids]
        if unknown:
            raise ValueError('%s 的 depends-on 含未知任务：%s' % (task['id'], ', '.join(unknown)))
        if task['id'] in task['deps']:
            raise ValueError('%s 不能依赖自己' % task['id'])
        if any(s not in originals for s in task['sourceTasks']):
            raise ValueError('%s 的 source-tasks 含未知的 19 节原任务' % task['id'])
        if task['module'] not in modules:
            raise ValueError('%s 的 module 不存在：%s' % (task['id'], task['module']))
        if any(e not in edges for e in task['edges']):
            raise ValueError('%s 的 edges 含未知边界' % task['id'])
        item = {k: task[k] for k in ('id', 'title', 'module', 'deps', 'input', 'output', 'accept', 'est', 'edges')}
        item.update({'repair': True, 'stableKey': task['stableKey'], 'sourceBatch': task['batch'],
                     'sourceTasks': task['sourceTasks'], 'sourceBatchTasks': record['tasks'],
                     'currentSourceBatch': matches[0] if matches else None, 'record': task['record'],
                     'severity': task['severity'], 'jev': task['jev']})
        data['tasks'].append(item)
        contracts[task['id']] = {'supportPaths': task['paths'], 'outputPaths': []}
    deps_of = {task['id']: task['deps'] for task in repairs}
    seen, visiting = set(), set()

    def walk(tid):
        if tid in visiting:
            raise ValueError('返工任务存在依赖环：' + tid)
        if tid in seen:
            return
        visiting.add(tid)
        for dep in deps_of.get(tid, []):
            if dep in deps_of:
                walk(dep)
        visiting.remove(tid)
        seen.add(tid)

    for tid in deps_of:
        walk(tid)
    return repairs, contracts


def ensure_repair_notes(root, repairs):
    """为覆盖层任务生成稳定任务笔记；只保留 status 与两个受保护区块，其他正文来自收口记录。"""
    directory = Path(root) / '图谱' / '任务'
    directory.mkdir(parents=True, exist_ok=True)
    for task in repairs:
        path = directory / (task['id'] + '.md')
        old = path.read_text(encoding='utf-8-sig') if path.exists() else ''
        status = 'todo'
        m = re.search(r'^status:\s*(\S+)', old, re.M)
        if m:
            status = m.group(1)

        def kept(name, placeholder):
            found = re.search(r'<!-- %s:begin -->(.*?)<!-- %s:end -->' % (name, name), old, re.S)
            return ('<!-- %s:begin -->%s<!-- %s:end -->' % (name, found.group(1), name)
                    if found else '<!-- %s:begin -->\n%s\n<!-- %s:end -->' % (name, placeholder, name))

        links = '、'.join('[[%s]]' % tid for tid in task['sourceTasks']) or '无'
        edges = '、'.join('[[%s]]' % edge for edge in task['edges']) or '无'
        text = '''---
type: task
id: {id}
status: {status}
module: {module}
source_batch: {batch}
stable_key: {stable}
---

# {id}　{title}

> 由第 {batch} 批收口记录 `{record}` 的未通过问题生成；stable-key 去重，原任务与原收口记录不改写。

- 所属模块：[[{module}]]
- 来源任务：{links}
- 前置依赖：{deps}
- 严重级：{severity}
- Jev 裁决：{jev}

## 输入 / 产出

- **输入**：{input}
- **产出**：{output}
- **有效路径**：{paths}

## 验收标准

{acceptance}

## 必须处理的边界

{edges}

## 代码位置

{code}

## 实施沉淀

{notes}
'''.format(id=task['id'], status=status, module=task['module'], batch=task['batch'],
           stable=task['stableKey'], title=task['title'], record=task['record'], links=links,
           deps='、'.join('[[%s]]' % d for d in task['deps']) or '无', severity=task['severity'],
           jev=task['jev'], input=task['input'], output=task['output'], paths='、'.join('`%s`' % p for p in task['paths']),
           acceptance=task['accept'], edges=edges,
           code=kept('code', '_落地前回填：`路径:行号` — 作用。_'),
           notes=kept('notes', '_落地前回填实现选择、失败教训与维护约束。_'))
        write_text(path, text)


def unwrapped_batches(tasks, progress, records, include_open=False):
    """已全部落地、尚未收口的批：[(1 起批次号, [任务ID…])]。include_open 包含最新记录有遗留的批；按 tasks 集合匹配，不看批次号"""
    lv = task_layers(tasks)
    by = {}
    for t in tasks:
        by.setdefault(lv[t["id"]], []).append(t["id"])
    latest = {}
    for record in sorted(records.values(), key=lambda r: str(r.get("date", ""))):
        latest[tuple(sorted(record["tasks"]))] = record
    out = []
    for k in sorted(by):
        ids = sorted(by[k])
        record = latest.get(tuple(ids))
        if all(progress.get(i) == "done" for i in ids) and (record is None or (include_open and record.get("verdict") == "open")):
            out.append((k + 1, ids))
    return out


def write_batches(root):
    """--batches：普通记录只改 batchRecords；含返工任务时走完整维护构建，生成可派任务。"""
    records = read_batch_records(root)
    repairs = collect_repair_tasks(records)
    if repairs:
        print("收口记录含 %d 个返工任务：完整重建交接台、派发包、契约与任务笔记" % len(repairs))
        run = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('maintain_docs.py')),
                              str(root), 'build'], text=True, encoding='utf-8')
        return run.returncode
    r = write_payload_key(root, "batchRecords", records)
    if r is None:
        print("docs-data.js 不存在或读不出来：先跑 python build_docs.py " + root + " 完整构建")
        return 1
    print("已写 docs-data.js 的 batchRecords：%d 条记录" % len(records))
    for name in sorted(records):
        rec = records[name]
        print("  %s：batch %s / %s / %s" % (name, rec["batch"], rec["date"] or "—", rec["verdict"] or "—"))
        if rec.get('repairWarning'):
            print('  ! ' + rec['repairWarning'])
    return 0


def mark_landed(root, ids):
    """--landed：写任务笔记头部的 status: done，再重写 progress.js。不重建阅读器"""
    groups, by_num = collect(root)
    data = extract(by_num) if groups else {"tasks": [], "edges": [], "endpoints": []}
    batch_records = read_batch_records(root)
    repair_tasks, repair_contracts = inject_repair_tasks(data, batch_records)
    ensure_repair_notes(root, repair_tasks)
    known = {t["id"] for t in data["tasks"]}
    bad = [i for i in ids if i not in known]
    if bad:
        print("未知任务，不写落地记录：" + "、".join(bad))
        return 1
    checked = analyze(root, data["tasks"], read_json(os.path.join(root, "_run", "presentation.json"), {}),
                      data["edges"], data["endpoints"], repair_contracts)
    current_report = read_json(os.path.join(root, "_run", "review.json"), {})
    ready = readiness(root, checked, current_report.get("items", []))
    if stale_reasons(root):
        print("产物或报告已过期；先维护同步并复核当前版本，不能记录落地。")
        return 1
    marker_path = os.path.join(root, "_run", "maintenance.js")
    if os.path.exists(marker_path):
        try:
            pending = json.loads(js_payload(read(marker_path).split("=", 1)[1], "")).get("pendingTasks", [])
        except (ValueError, IndexError):
            print("维护状态无法读取；先修复同步状态再记录落地。")
            return 1
        if any(i in pending for i in ids):
            print("文档补丁尚在同步；先完成补丁再落地。")
            return 1
    blocked = [i for i in ids if not ready.get(i, {}).get("ready")]
    if blocked:
        print("任务契约未复核，不能记录落地：" + "、".join(blocked))
        return 1
    ok = []
    for i in ids:
        if i in bad:
            continue
        p = os.path.join(root, "图谱", "任务", i + ".md")
        if os.path.exists(p):
            text = read(p)
            m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
            if m and re.search(r"^status:", m.group(1), re.M):
                fm = re.sub(r"^status:.*$", "status: done", m.group(1), count=1, flags=re.M)
            elif m:
                fm = m.group(1) + "\nstatus: done"
            else:
                fm = None
            if fm is not None:
                text = text[:m.start(1)] + fm + text[m.end(1):]
            else:
                text = "---\nid: %s\nstatus: done\n---\n%s" % (i, text)
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            print("  %s → status: done（%s）" % (i, os.path.relpath(p, root)))
        else:
            print("  ! 没找到 %s（知识库没建？）：%s 只记进 progress.js，整体重跑前别删它"
                  % (os.path.relpath(p, root), i))
        ok.append(i)
    revalidation = read_json(os.path.join(root, "_run", "revalidation.json"), {})
    for i in ok:
        revalidation.pop(i, None)
    write_json(os.path.join(root, "_run", "revalidation.json"), revalidation)
    # 保留正在同步的文档补丁锁，只解除本次已验收任务的代码复核标记。
    marker_path = os.path.join(root, "_run", "maintenance.js")
    marker_value = {"pendingTasks": [], "needsReview": sorted(revalidation)}
    if os.path.exists(marker_path):
        text = read(marker_path)
        try:
            marker_value["pendingTasks"] = json.loads(js_payload(text.split("=", 1)[1], "")).get("pendingTasks", [])
        except (ValueError, IndexError):
            pass
    if any(i in marker_value["pendingTasks"] for i in ok):
        print("文档补丁尚在同步；先完成补丁再落地。")
        return 1
    write_text(marker_path, "window.MAINTENANCE = " + json.dumps(marker_value, ensure_ascii=False) + ";\n")
    st = progress_state(root)
    for i in ok:
        st[i] = "done"
    write_progress(root, st)
    write_progress_payload(root, st)
    landed = len([v for v in st.values() if v == "done"])
    print("已写 _run/progress.js 与 docs-data.js 的 progress：已落地 %d%s" % (landed, "/%d" % len(known) if known else ""))
    print("  刷新阅读器的交接台即可看到「已落地」，依赖这些任务的「实施」按前置与收口闸门解锁；别的检出 git pull 后同样看得到")
    if revalidation:
        print("  仍待复验的已落地任务：%s（交接台显示「已落地·待复验」，点该行「审查」得到复验提示词）" % "、".join(sorted(revalidation)))
    print("  工作树与 planning 目录当场清理；漏了的用 python \"%s/_run/maintain_docs.py\" \"%s\" workspace 列出" % (root, root))
    handoff = read_json(os.path.join(root, "_run", "presentation.json"), {}).get("handoff", {})
    wrapup_gate = handoff.get("wrapupGate") is not False
    skips = handoff.get("wrapupGateSkipRecords")
    skips = skips if isinstance(skips, dict) else {}
    records = read_batch_records(root)
    for n, ids_in in unwrapped_batches(extract(by_num)["tasks"], st, records, include_open=wrapup_gate):
        matching = sorted(((name, record) for name, record in records.items()
                           if record["tasks"] == ids_in),
                          key=lambda pair: (str(pair[1].get("date", "")), pair[0]))
        latest = matching[-1] if matching else None
        skipped = bool(latest and latest[1].get("verdict") == "open" and skips.get(str(n)) == latest[0])
        print("  第 %d 批已全部落地、尚未收口%s（%s）：交接台点该批标题右侧「批次收口」%s" % (
            n, "或收口有遗留" if wrapup_gate else "", "、".join(ids_in),
            "（当前 open 记录已定点跳过闸门；返工仍待处理）" if skipped else
            "（wrapupGate 开启时下一批的实施已上锁）" if wrapup_gate else ""))
    if bad:
        print("  ! 不在 19 节任务表里，没记：%s" % "、".join(bad))
        return 1
    return 0


def orch_line(pres, blocks):
    if blocks:
        return "presentation.json（%d 块）" % len(blocks)
    if pres:
        return "默认排布（presentation.json 在，但没写 blocks）"
    return "默认（未提供 presentation.json）"


def main():
    args = sys.argv[1:]
    if "--landed" in args:
        i = args.index("--landed")
        root = args[0] if i > 0 else ""
        ids = [a for a in args[i + 1:] if not a.startswith("--")]
        if not root or not os.path.isdir(root) or not ids:
            print("用法：python build_docs.py <文档目录> --landed <任务ID> [<任务ID>…]")
            return 2
        return mark_landed(root, ids)
    if "--batches" in args:
        root = args[0] if args and not args[0].startswith("--") else ""
        if not root or not os.path.isdir(root):
            print("用法：python build_docs.py <文档目录> --batches")
            return 2
        return write_batches(root)
    if len(args) != 1:
        print(__doc__)
        return 2
    root = args[0]
    if not os.path.isdir(root):
        print("需要传一个目录：" + root)
        return 2

    groups, by_num = collect(root)
    if not groups:
        print("目录下没找到任何分组子目录（应形如 00-概览/01-概述与目标.md）")
        return 2

    data = extract(by_num)
    batch_records = read_batch_records(root)
    repair_tasks, repair_contracts = inject_repair_tasks(data, batch_records)
    ensure_repair_notes(root, repair_tasks)

    pres = {}
    pp = os.path.join(root, "_run", "presentation.json")
    if os.path.exists(pp):
        try:
            pres = json.loads(read(pp))
        except ValueError as e:
            print("presentation.json 解析失败：%s" % e)
            return 2

    review = None
    rp = os.path.join(root, "_run", "review.json")
    if os.path.exists(rp):
        try:
            r = json.loads(read(rp))
            cov = None
            for it in r.get("items", []):
                m = re.search(r"边界覆盖率\s*(\d+)%", it.get("msg", ""))
                if m:
                    cov = int(m.group(1))
            review = {"block": r.get("block", 0), "warn": r.get("warn", 0), "coverage": cov,
                      "current": r.get("sourceVersion") == source_version(root)}
        except (ValueError, KeyError):
            pass

    checked = analyze(root, data["tasks"], pres, data["edges"], data["endpoints"], repair_contracts)
    report = read_json(os.path.join(root, "_run", "review.json"), {})
    checked["readiness"] = readiness(root, checked, report.get("items", []))
    if report.get("sourceVersion") != checked["sourceVersion"]:
        for entry in checked["readiness"].values():
            entry["ready"] = False
            entry["reasons"].append("结构检查缺失或已过期，运行维护同步命令")
            entry.setdefault("blockers", []).append("结构检查缺失或已过期，运行维护同步命令")
    # 落地记录进 payload：随 docs-data.js 进仓库，别的检出 git pull 就看得到；本机 progress.js 只是覆盖
    progress = progress_state(root)
    # 笔记回填是提示词上下文，不进入 analyze 已计算的任务契约及其哈希。
    data["tasks"] = [dict(t) for t in data["tasks"]]
    read_code_refs(root, data["tasks"])
    payload = {
        "schemaVersion": 1,
        "handoff": checked,
        "project": pres.get("project") or os.path.basename(os.path.abspath(root)),
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "review": review,
        "groups": groups,
        "data": data,
        "pres": pres,
        "index": chip_index(data),
        "progress": progress,
        "batchRecords": batch_records,
        "repairTasks": repair_tasks,
    }

    # 固定的提示词函数共用同一实现；编译器也要看到已落地历史及本次复验标记，dispatch.json 才与浏览器同源。
    maintenance = {"pendingTasks": [], "needsReview": sorted(read_json(os.path.join(root, "_run", "revalidation.json"), {}))}
    core = prompt_compiler_core(progress, maintenance)
    compiled = subprocess.run(["node", str(Path(__file__).with_name("compile_prompts.js"))],
                              input=json.dumps({"payload": payload, "core": core}, ensure_ascii=False),
                              text=True, encoding="utf-8", capture_output=True, timeout=30)
    if compiled.returncode:
        print("提示词编译失败：" + compiled.stderr)
        return 2
    compiled_out = json.loads(compiled.stdout)
    payload["dispatch"] = compiled_out["tasks"]
    budget = (pres.get("handoff") or {}).get("promptBudget", 12000)
    for tid, prompts in payload["dispatch"].items():
        for kind, label in (("implementation", "实施"), ("review", "审查")):
            size = len(prompts[kind])
            if size > budget:
                largest = sorted(prompts["sections"][kind], key=lambda s: s[1], reverse=True)[:3]
                print("  ! %s %s提示词 %d 字符，超预算：最大三段 %s" %
                      (tid, label, size, "；".join("<%s %d 字符>" % (name, n) for name, n in largest)))
    # 每批收口提示词随产物导出；contractHash 是本批任务契约哈希的摘要，下游按 tasks 集合匹配本批
    payload["dispatchBatches"] = {}
    for k, b in compiled_out.get("batches", {}).items():
        b = dict(b)
        b["contractHash"] = digest(sorted([[i, (checked["contracts"].get(i) or {}).get("hash")] for i in b["tasks"]]))
        payload["dispatchBatches"][k] = b
    previous = None
    if os.path.exists(os.path.join(root, "docs-data.js")):
        old = read(os.path.join(root, "docs-data.js"))
        try:
            previous = json.loads(js_payload(old, "window.DOCS = "))
        except ValueError:
            pass
    if previous:
        before = {k: v for k, v in previous.items() if k != "generated"}
        after = {k: v for k, v in payload.items() if k != "generated"}
        if before == after:
            payload["generated"] = previous.get("generated")
    write_text(os.path.join(root, "docs-data.js"), "window.DOCS = " + json.dumps(payload, ensure_ascii=False) + ";\n")
    write_json(os.path.join(root, "_run", "dispatch.json"), {
        "schemaVersion": 1, "sourceVersion": checked["sourceVersion"], "tasks": payload["dispatch"],
        "batches": payload["dispatchBatches"]})
    write_text(os.path.join(root, "index.html"), HTML)
    if not os.path.exists(os.path.join(root, "_run", "maintenance.js")):
        write_text(os.path.join(root, "_run", "maintenance.js"), "window.MAINTENANCE = {\"pendingTasks\":[],\"needsReview\":[]};\n")
    write_progress(root, progress)

    n = sum(len(g["docs"]) for g in groups)
    blocks = pres.get("blocks")
    print("已生成 index.html 与 docs-data.js")
    print("  文档 %d 篇 / 模块 %d / 任务 %d / 边界 %d / 批次 %d / 风险 %d / 术语 %d / 接口 %d"
          % (n, len(data["modules"]), len(data["tasks"]), len(data["edges"]),
             len(data["milestones"]), len(data["risks"]), len(data["terms"]), len(data["endpoints"])))
    dec, chg = data["decisions"], data["changes"]
    if dec or chg:
        flawed = len([d for d in dec if d["review"] == "flawed"])
        low = len([d for d in dec if d["conf"] == "low"])
        print("  演进与决策：决策 %d 条（被驳回 %d、低置信 %d）/ 版本 %d 个%s"
              % (len(dec), flawed, low, len(chg),
                 "" if any(c["decs"] for c in chg)
                 else "；23 节没写「涉及决策」列，决策全挂在首版下"))
    print("  编排：%s" % orch_line(pres, blocks))

    ho = pres.get("handoff") or {}
    if data["tasks"]:
        miss = [k for k in ("stack", "repo", "docsPath") if not ho.get(k)]
        print("  任务提示词：%d 个任务，各一份实施 / 审查 / 查 bug 提示词，另有全项目查 bug 一份%s"
              % (len(data["tasks"]),
                 "；handoff 缺 %s，这些位置退到通用默认值" % "、".join(miss) if miss else ""))
        landed = len([v for v in progress.values() if v == "done"])
        print("  落地记录：%d/%d 个任务已落地（来自 图谱/任务 笔记头部的 status，写进 _run/progress.js）"
              % (landed, len(data["tasks"])))
        print("  批次收口：%d 批各一份收口提示词（dispatchBatches）；收口记录 %d 条（_run/batches/）"
              % (len(payload["dispatchBatches"]), len(payload["batchRecords"])))
        for n, ids_in in unwrapped_batches(data["tasks"], progress, payload["batchRecords"]):
            print("    第 %d 批已全部落地、尚未收口：%s" % (n, "、".join(ids_in)))
        if ho.get("design") and not ho.get("frontendModules"):
            print("  提示：handoff.design 写了视觉方向，但没写 frontendModules，前端任务拿不到它")

        arch = ho.get("architecture") or {}
        if arch and not ho.get("wiring"):
            print("  提示：写了 handoff.architecture 但没写 handoff.wiring（接线注册表），"
                  "接线任务的注册点不会并入有效范围，H12 也不会提醒漏列")
        wiring_warns = [i for i in checked["issues"] if i["code"] in ("H12", "H13")]
        if wiring_warns:
            print("  接线提示：H12/H13 共 %d 条（不阻断；review.py 看明细）" % len(wiring_warns))
        if (ho.get("wiring") or {}).get("judgments"):
            jt = [tid for tid, c in checked["contracts"].items()
                  if (c.get("context") or {}).get("wiring", {}).get("judgments")]
            print("  判断层：wiring.judgments 已登记，%d 个任务声明了 judgments，它们的提示词会带 typesafe-ai 与密钥规则%s"
                  % (len(jt), "" if jt else "；一个都没声明，问题常量文件没人负责"))
        jl = os.path.join(root, "_run", "judgments.jsonl")
        if os.path.isfile(jl):
            with open(jl, encoding="utf-8") as fh:
                n_j = sum(1 for line in fh if line.strip())
            print("  TypeSafe 第二意见：_run/judgments.jsonl 共 %d 条记录（typesafe_ask.py --log 追加；不进产物指纹）" % n_j)
        if not arch:
            print("  提示：没写 handoff.architecture，任务提示词里不带目录与分层约束，"
                  "各任务会自己定一套")
        else:
            def seg_stat(name):
                v = arch.get(name)
                if isinstance(v, dict):
                    return len([k for k, x in v.items() if x]), "项"
                if isinstance(v, str) and v.strip():
                    return 1, "整段"
                return 0, ""
            bits, loose = [], []
            for name, label in (("shared", "共用"), ("frontend", "前端"), ("backend", "后端")):
                n, unit = seg_stat(name)
                bits.append("%s %d%s" % (label, n, unit or "项"))
                if unit == "整段":
                    loose.append(name)
            print("  架构约定：" + " / ".join(bits))
            if loose:
                print("    提示：%s 是整段字符串，拆成分项（ui/data/utils/errors/env…）"
                      "后提示词里会一项一行，更难被忽略" % "、".join(loose))
            if not arch.get("shared"):
                print("    提示：没写 architecture.shared，错误码与环境变量这类"
                      "前后端必须一致的约定不会进任何提示词")
            if arch.get("frontend") and not ho.get("frontendModules"):
                print("    提示：写了 architecture.frontend，但没写 frontendModules，"
                      "所有任务都会收到后端那份")
            if not arch.get("backend"):
                print("    提示：architecture 只写了前端，非前端任务不带分层约束")

            def seg_len(name):
                v = arch.get(name)
                if isinstance(v, dict):
                    return sum(len(str(x)) for x in v.values() if x)
                return len(v.strip()) if isinstance(v, str) else 0
            fat = [(label, seg_len(name))
                   for name, label in (("shared", "共用"), ("frontend", "前端"), ("backend", "后端"))
                   if seg_len(name) > 2500]
            if fat:
                print("    提示：架构约定偏长（%s），它会原样进每条实施与审查提示词。"
                      "一项压到一两句、只留能写进代码的禁令，提示词就短了"
                      % "、".join("%s %d 字" % x for x in fat))
        dz = ho.get("design")
        if dz and len(json.dumps(dz, ensure_ascii=False)) > 4000:
            print("  提示：handoff.design 有 %d 字，每个前端任务的提示词都会带上它；"
                  "tokens 与 components 保留，形容词段落能删就删"
                  % len(json.dumps(dz, ensure_ascii=False)))

        ids = {t["id"] for t in data["tasks"]}
        tp = ho.get("taskPaths") or {}
        if not tp:
            print("  并发防护：只按依赖分批。补 handoff.taskPaths 可再挡住「两个任务抢同一个文件」")
        else:
            no_path = sorted(ids - set(tp))
            ghost = sorted(set(tp) - ids)
            print("  并发防护：依赖分批 + 路径冲突检测（%d/%d 个任务标了路径）"
                  % (len(ids & set(tp)), len(ids)))
            if no_path:
                print("    ! %s 没标路径，冲突检测对它们无效：%s"
                      % (len(no_path), "、".join(no_path[:8]) + ("…" if len(no_path) > 8 else "")))
            if ghost:
                print("    ! taskPaths 里有不存在的任务：%s" % "、".join(ghost[:8]))

        ts = ho.get("taskSkills") or {}
        fe = len([t for t in data["tasks"] if t["module"] in (ho.get("frontendModules") or [])])
        print("  技能指引：两份提示词都按任务特征注入（栈位置、栈顶、界面任务）%s"
              % ("；%d 个界面任务会要求录 GIF" % fe if fe else ""))
        if ts:
            print("    另有 %d 个任务在 taskSkills 里点名了追加技能" % len(set(ts) & ids))
            g2 = sorted(set(ts) - ids)
            if g2:
                print("    ! taskSkills 里有不存在的任务：%s" % "、".join(g2[:8]))

    for k, sec in (("modules", "06"), ("tasks", "17"), ("edges", "11"),
                   ("milestones", "18"), ("risks", "19"),
                   ("decisions", "20"), ("changes", "21")):
        if not data[k]:
            print("  提示：没抽到 %s，检查 %s 节的表格列序是否符合约定" % (k, sec))
    print("  双击 index.html 即可浏览（无需本地服务器）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
