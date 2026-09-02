#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开发文档阅读器生成脚本（组件库 + 模型编排）

用法:
    python build_docs.py <文档目录>

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

交接台把文档反过来编译成「任务提示词」：每个任务一键复制出可直接粘给写代码模型的
实施指令、以及交活后用的审查指令。提示词是自包含的——任务卡全字段、依赖任务标题、
涉及的每条 E-XX 完整定义都内联进去，读提示词的模型不翻文档也能开工。提示词里的
项目侧信息（技术栈、仓库名、分支前缀、视觉方向）来自 presentation.json 的
handoff 段，缺了就退到通用默认值。

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
import json
import os
import re
import sys

GROUP_ORDER = ["00-概览", "01-约束", "02-设计", "03-质量", "04-执行", "05-附录"]
FENCE = chr(96) * 3

HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>开发文档</title>
<script src="docs-data.js"></script>
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
  letter-spacing:.05em;color:var(--muted);background:var(--panel);border-bottom:1px solid var(--rule)}
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
.cp.big{font-family:var(--sans);font-size:12.5px;font-weight:600;padding:6px 13px;
  color:var(--accent);border-color:var(--accent-line);background:var(--paper)}
.card .acts{display:flex;gap:7px;margin-top:11px;padding-top:10px;border-top:1px solid var(--rule)}

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

.htask .st{flex:none;width:52px;padding:2px 0;font-family:var(--mono);font-size:10px;text-align:center;
  color:var(--muted);border:1px solid var(--rule-strong);border-radius:3px}
.htask .st:hover{color:var(--accent);border-color:var(--accent-line)}
.htask.doing{background:#FFFCF4}
.htask.doing .st{color:var(--warn);background:#FCF6E8;border-color:#E5D3A6}
.htask.done{opacity:.48}
.htask.done .st{color:var(--pass);background:#F2F9F6;border-color:#BFDDD0}
.htask.done .htt{text-decoration:line-through;text-decoration-color:var(--rule-strong)}
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
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
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
var SVGID = /\b(E-\d{2,3}|M\d{1,2}-T\d{1,3})\b/g;
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
var IDRE = /\b(E-\d{2,3}|M\d{1,2}-T\d{1,3})\b/g;
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
         "<dt>预估</dt><dd>"+esc(t.est||"—")+"</dd></dl>"+
         '<div class="acts">'+
         '<button class="cp" data-kind="impl" data-task="'+esc(id)+'">复制实施提示词</button>'+
         '<button class="cp" data-kind="review" data-task="'+esc(id)+'">复制审查提示词</button></div>';
  } else if(m){
    /* 时序图和状态机图上的参与方按约定就是模块 ID，点了要能看到它是干什么的 */
    h += "<dl><dt>职责</dt><dd>"+esc(m.role||"—")+"</dd>"+
         "<dt>依赖</dt><dd>"+esc(m.dep||"无")+"</dd>"+
         "<dt>任务</dt><dd>"+((m.tasks||[]).join("、") || "—")+"</dd></dl>";
  } else {
    h += '<div class="miss">没找到这个编号的定义——可能是引用写错了，或它还没被定义。</div>';
  }
  card.innerHTML = h; card.hidden = false;
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
    var txt = promptFor(cp.dataset.kind, cp.dataset.task);
    if(txt) copyText(txt, cp);
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
    if(row){ var id = row.dataset.t; setSt(id, ST_NEXT[stOf(id)]); refreshHand(); }
    ev.stopPropagation(); return;
  }
  if(ev.target.closest('[data-act="reset"]')){
    if(confirm("把所有任务的状态清回「待派」？只影响本机记录，不动文档也不动代码。")){
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

/* 按依赖算层级：层号 = 最长前驱链长度。有环则就地截断，不死循环 */
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

/* ── 派活进度：状态存本机浏览器，用来算「此刻能并发派哪几个」 ── */
var PKEY = "unattended-run/" + (D.project || "docs") + "/progress";
var PG = {};
try { PG = JSON.parse(localStorage.getItem(PKEY) || "{}") || {}; } catch(e){ PG = {}; }
var ST_NEXT = {todo:"doing", doing:"done", done:"todo"};
var ST_TEXT = {todo:"待派", doing:"进行中", done:"已落地"};
function stOf(id){ return PG[id] || "todo"; }
function setSt(id, v){
  if(v === "todo") delete PG[id]; else PG[id] = v;
  try { localStorage.setItem(PKEY, JSON.stringify(PG)); } catch(e){}
}

/* ── 路径冲突：依赖层级只保证逻辑不冲突，两个任务照样能抢同一个文件 ── */
var TP = HO.taskPaths || {};
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

/* ── 该调哪些技能：按任务自身特征算，不是贴一份通用清单 ── */
function isFrontend(mod){ return (HO.frontendModules||[]).indexOf(mod) >= 0; }
/* 谁依赖我。没有下游依赖就是栈顶，整栈可以落地了 */
function dependentsOf(id){
  return (DT.tasks||[]).filter(function(x){ return (x.deps||[]).indexOf(id) >= 0; });
}
/* side 取 "impl"（给写代码的）或 "review"（给审查的）。
   每条给三样：什么时候调、调了能拿到什么、不调会漏什么。**只写「什么时候调」的话
   模型会把它当可选步骤跳过去**——写清收益和代价，它才会主动去调。
   判准本身不抄进来，技能自己是正本，抄了就成同一事实的两份表示。
   返回 [名字, 时机, [收益与代价的若干行]]。
   只在判 doc-issue 时才用的那两个不进这张表，写在对应分支处更准。 */
function skillsFor(t, side){
  var S = [];
  if(side === "impl"){
    S.push(["gh-stack", "第 1 步切层、第 3 步 push", [
      "给你 gh stack 每条命令的细节和它的非交互标志。",
      "不调：view 不带 --json 会开全屏 TUI 并永久阻塞，它不报错，你会以为还在跑。"]]);
    S.push(["dsh-prose-standard", "写「实施沉淀」时", [
      "给你「写够了没有」的判准：先枚举这段话里的每个命题——行为方、条件、时序、",
      "否定保证、所有权、失败模式——全部存活才算改进，单纯变短不算。",
      "不调：沉淀写成一句正确的废话，下一个人看不出约束在哪。"]]);
    S.push(["dsh-trim-cot-leakage", "沉淀写完之后过一遍", [
      "给你一条自检：HEAD 上的读者没有你这次的会话记录，能不能解析每个引用。",
      "不调：「本来想…后来改成」这类话留在笔记里，三个月后没人解析得了。"]]);
    if(isFrontend(t.module)) S.push(["finesse-ui", "动手写组件与样式时", [
      "给你组件级的落地细节：这个 register 下该用哪个组件、间距与状态色怎么落、",
      "一个组件的八个状态（默认/悬停/聚焦/按下/禁用/加载/错误/空）要发全，",
      "可访问性基线要满足什么（键盘可达、对比度、焦点顺序），手机上怎么不塌。",
      "register 和视觉方向上面已经给死了——它是帮你把那套 token 落成代码，",
      "不是重新判一次 register、重新设计一版；再判一次只会得到另一套色板。",
      "不调：组件从零手搓，可访问性靠猜，同一个交互每个页面一种写法。"]]);
    if(isFrontend(t.module)) S.push(["record-browser-gif", "交审查之前", [
      "给你录 GIF 的完整做法：等待条件要用具体 DOM 状态而不是固定延时，",
      "完成判据要精确文本匹配（includes 会被提示词的回显骗过）。",
      "不调：界面改动只能靠你自己说「已实现」，审查方看不见实际效果，多半打回。"]]);
  }else{
    S.push(["dsh-code-review", "逐条打勾之后，见「怎么审」最后一步", [
      "给你一套验收标准查不出来的检查项：接口两侧的契约对不对得上、生命周期与并发、",
      "有没有绕过校验的入口、借用 vs 拥有的状态、测试断言是不是只把实现重写了一遍。",
      "不调：会放过「每条验收标准都做了，但合起来是错的」这一整类问题。"]]);
    if(isFrontend(t.module)) S.push(["finesse-ui", "核界面实现时，看 GIF 之前", [
      "用它的 audit 命令——只读，不改代码，跑完给一份发现清单。",
      "查的是 GIF 看不出来的那些：组件八个状态发全了没、对比度与焦点顺序、",
      "有没有踩偷懒默认（渐变文字、玻璃拟态、每节一个小标签、一模一样的图标卡），",
      "以及手机上的六类硬伤（横向溢出、图片撑破栅格、按钮文字换行、粘性头失效）。",
      "不调：只能判断「看起来对不对」，查不出焦点顺序错乱、对比度不足这类问题。"]]);
    if(isFrontend(t.module)) S.push(["record-browser-gif", "要验收证据时", [
      "告诉你这类任务的 GIF 要满足什么才算证据：真实服务、真实轮次，不许 fixture 或 mock。",
      "不调：拿不到可核验的界面证据，只能信实现方的自述。"]]);
    S.push(["dsh-prose-standard", "核回填质量时", [
      "给你量回填的尺子：原来那些命题有没有被删掉。",
      "不调：回填看着有内容，其实把「谁在什么条件下保证什么」删成了废话。"]]);
    S.push(["dsh-trim-cot-leakage", "核回填质量时", [
      "给你 8 类会话残渣的识别方法，以及 9 类不算残渣、必须留着的东西。",
      "不调：要么放过残渣，要么矫枉过正，把仍然有效的信息一起删了。"]]);
    S.push(["dsh-pre-push-checks", "判 pass 之后、落地之前", [
      "给你按 outgoing diff 挑最小充分证据集的做法，外加几条红线：不许用",
      "--passWithNoTests 或调低阈值掩盖未覆盖文件，不许裸 --force。",
      "不调：要么不跑测试直接落，要么每次全量跑到后面没人愿意跑。"]]);
    S.push(["dsh-merging-stacked-prs", "落地这一栈时", [
      "给你整栈落地前后的完整约束：核对栈成员与顺序、确认每层 open 且非 draft、",
      "等每个 PR 都报 MERGED、零依赖才允许删分支。",
      dependentsOf(t.id).length
        ? "注意这一层上面还压着 " + dependentsOf(t.id).map(function(x){ return x.id; }).join("、") +
          "，现在不要单独落它。"
        : "这一层是栈顶，整栈可以落地了。",
      "不调：退化成一个个 gh pr merge，下层合完之后上层的 base 就悬空了。"]]);
    S.push(["dsh-find-simplifications", "闻到两处在镜像同一事实时", [
      "给你把模糊的「这里好像重复」变成有实证提案的办法：先按生产、非生产、模糊",
      "三类分清消费者，再下结论。",
      "不调：要么就地乱改扩大本次范围，要么给出一堆「跑一次 knip」这种薄建议。"]]);
  }
  /* 推断不到的情况留个逃生口：编排里点名的追加在后面 */
  ((HO.taskSkills || {})[t.id] || []).forEach(function(x){
    if(typeof x === "string") S.push([x, "本项目为这个任务点名的", []]);
    else if(x && x.name)      S.push([x.name, x.when || "本项目为这个任务点名的",
                                      x.why ? [x.why] : []]);
  });
  return S;
}
function skillBlock(t, side){
  var S = skillsFor(t, side);
  if(!S.length) return "";
  var L = ["", "## 这个任务要用的技能", ""];
  L.push("每条写了三样：在哪一步调、调了能拿到什么、不调会漏什么。" +
         (side === "impl" ? "按时机调，别等做完才想起来。"
                          : "判准在技能里，这份提示词不抄一遍。"));
  L.push("");
  S.forEach(function(x){
    L.push("- `" + x[0] + "`　" + x[1]);
    (x[2]||[]).forEach(function(g){ L.push("  " + g); });
  });
  return L.join("\n");
}

function waitingOn(t){
  return (t.deps||[]).filter(function(d){ return stOf(d) !== "done"; });
}
/* 此刻能同时派出去的一组：依赖已落地、自己还没派、彼此之间以及与在跑的都不抢文件 */
function dispatchable(){
  var tasks = DT.tasks || [];
  var busy = tasks.filter(function(x){ return stOf(x.id) === "doing"; });
  var out = [];
  tasks.forEach(function(t){
    if(stOf(t.id) !== "todo" || waitingOn(t).length) return;
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
    if(stOf(t.id) === "done"){ finish[t.id] = 0; merged.push(t.id); }
  });
  var rest = tasks.filter(function(t){ return stOf(t.id) !== "done"; });

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
  var serial = tasks.filter(function(t){ return stOf(t.id) !== "done"; })
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
    return "（本任务的验收标准没挂边界编号。仍要按常识处理空输入、失败路径和重复提交。）";
  return ids.map(function(id){
    var e = findBy(DT.edges, id);
    if(!e) return "- " + id + "（文档里没找到这条边界的定义，动手前先确认）";
    return "- " + id + "　" + (e.scene||"") + "\n" +
           "    触发：" + (e.trigger||"—") + "\n" +
           "    期望：" + (e.expect||"—");
  }).join("\n");
}

function depBlock(deps){
  if(!deps || !deps.length) return "无前置依赖，可直接开工。";
  return deps.map(function(d){
    var t = taskById(d);
    return "- " + d + (t ? "　" + t.title : "") + "（已完成并落地）";
  }).join("\n");
}

/* 视觉方向只发给前端模块的任务——否则后端任务里塞色板是噪音 */
function designBlock(mod){
  var d = HO.design;
  if(!d || !isFrontend(mod)) return "";
  var L = ["", "## 视觉方向（已经定过，按它实现，不要自由发挥）"];
  if(d.register)  L.push("- **register：" + d.register + "**（这一条是前提，别自己重判）");
  if(d.dials)     L.push("- 三档刻度：" + d.dials);
  if(d.tone)      L.push("- 基调：" + d.tone);
  if(d.palette)   L.push("- 色板：" + d.palette);
  if(d.type)      L.push("- 字体：" + d.type);
  if(d.layout)    L.push("- 布局：" + d.layout);
  if(d.signature) L.push("- 标志性元素：" + d.signature);
  if(d.avoid)     L.push("- 要避开：" + d.avoid);
  if(d.tokens){
    L.push("");
    L.push("下面这套 token 直接用，不要自己另编颜色、字号和圆角：");
    L.push("```css");
    L.push(String(d.tokens).replace(/^\n+|\n+$/g, ""));
    L.push("```");
  }
  if(d.components){
    L.push("");
    L.push("组件规范（尺寸、圆角、状态色照这个来）：");
    L.push(String(d.components));
  }
  L.push("");
  L.push("完整说明在文档 11-UI 的「视觉方向」小节。拿不准的地方去查它，别自己发明一套。");
  L.push("要查某个组件具体怎么写、八个状态怎么覆盖、手机上怎么不塌，调 finesse-ui；");
  L.push("**但不要让它重判 register、重定方向**——上面这些就是它上一趟定完的结果，");
  L.push("再判一次只会得到另一套色板。这一趟它的活是把 token 落成代码，不是重新设计。");
  return L.join("\n");
}

/* 三段结构的字段名 → 提示词里的中文标签。
   顺序就是提示词里的出现顺序：先定死放哪（目录、分层），再是每天都要碰的（组件库、
   数据层、工具、错误、环境变量），最后是收尾的（构建、后台任务）。
   没在表里的字段名会原样当标签输出，所以自定义字段不会被吞掉 */
var ARCH_LABEL = {
  errors: "错误体系", env: "环境变量", naming: "命名与格式", types: "共享类型",
  layout: "目录结构", layers: "分层与调用方向",
  ui: "组件库", state: "状态管理", route: "路由", tier: "组件分层",
  api: "API 客户端层", data: "数据层", middleware: "中间件链", tx: "事务边界",
  utils: "工具层", config: "配置装载", di: "依赖注入",
  build: "构建产物", jobs: "后台任务"
};
var ARCH_ORDER = ["layout", "layers", "tier", "ui", "route", "state", "api", "data",
                  "middleware", "tx", "utils", "errors", "env", "config", "di",
                  "build", "jobs"];

/* 一段架构配置渲染成若干行。字符串形式原样输出（旧配置兼容），
   对象形式按 ARCH_ORDER 拆成一项一行——十几项糊成一段，读的人抓不住哪条是禁令 */
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

/* 框架架构按前后端分发。和 designBlock 不同——这个两边都要发：
   后端任务同样需要知道分层、调用方向和事务边界，不给它就自己定一套。
   shared 段是前后端必须一致的那几条（错误码、环境变量、命名、共享类型），
   两边都发——只发一侧，另一侧迟早写出第二套 */
function archBlock(mod){
  var a = HO.architecture;
  if(!a) return "";
  var fe = isFrontend(mod);
  var sh = archLines(a.shared);
  var own = archLines(fe ? a.frontend : a.backend);
  if(!sh.length && !own.length) return "";
  var L = [];
  if(sh.length){
    L.push("");
    L.push("## 全项目共用约定（前后端必须一致，不许自己另立一套）");
    L = L.concat(sh);
    L.push("");
    L.push("这几条在 06 节「全项目共用约定」里，改它要回文档改，不要在代码里绕。");
  }
  if(own.length){
    L.push("");
    L.push("## 框架架构（已经定过，照它组织代码，不要自己另起一套）");
    L = L.concat(own);
    L.push("");
    L.push("完整说明在文档 " + (fe ? "07-前端架构" : "08-后端架构") +
           "。目录怎么分、状态放哪、哪层不许调什么都在那一节，别凭感觉摆文件。");
  }
  return L.join("\n");
}

/* 角色段。重点不是戴帽子，是划权限边界：实施侧要压住「顺手重构」的冲动，
   审查侧要把「有没有守住架构」列进职责——只核验收标准的话，架构漂移没人管。
   没配 architecture 也给通用角色，空着等于默认它可以自由发挥 */
function roleBlock(t, side){
  var fe = isFrontend(t.module);
  var has = !!HO.architecture;
  var who = has ? (fe ? "前端" : "后端") : "";
  var sec = fe ? "07 节" : "08 节";
  var L = ["", "## 你的角色"];
  if(side === "impl"){
    L.push("你是这个项目的" + who + "开发工程师。" +
           (has ? "架构已经在 " + sec + "（外加 06 节的共用约定）定死了，下面那两段是它的摘要。"
                : "本任务的约定以开发文档为准。"));
    L.push("你的活是**在既定约定内实现这一个任务**——不是重新设计架构，也不是顺手优化目录结构。");
    L.push("哪一条挡住你了，停下来在回报里说明，不要绕过去自己起一套：绕过去的那一套，");
    L.push("下一个任务不知道，第三个任务又会起第三套。");
  }else{
    L.push("你是这个项目的" + who + "架构师。除了「功能做没做」，你还要审" +
           (has ? "**这一层有没有守住 " + sec + " 与 06 节的约定**：" : "**架构一致性**："));
    if(fe){
      L.push("组件放对层了没有、有没有绕过 API 客户端层直接发请求、");
      L.push("有没有硬编码本该走环境变量或错误码枚举的值、组件库是直接引原始组件还是走了二次封装。");
    }else{
      L.push("有没有跨层调用或反向依赖、事务是不是开在约定的那一层、");
      L.push("有没有硬编码本该走环境变量的值、错误有没有走统一错误体系而是自己拼了一个。");
    }
    L.push("这类问题验收标准查不出来——每条标准都满足，架构照样能歪。");
  }
  return L.join("\n");
}

/* 提示词里的 git 命令是给人直接粘去执行的，标题里的双引号会把 -m "" 撑破。
   名字不能叫 q——下面「导航与渲染」段的 var q 是搜索框，会把同名函数覆盖掉 */
function shq(s){ return String(s||"").replace(/"/g, "'"); }

function promptHead(t){
  var m = findBy(DT.modules, t.module);
  var L = ["## 项目", "- 项目：" + D.project];
  if(HO.stack) L.push("- 技术栈：" + HO.stack);
  L.push("- 开发文档：" + HDOCS);
  L.push("");
  L.push("## 本任务");
  L.push("- 所属模块：" + t.module + (m ? "　" + m.role : ""));
  L.push("- 输入：" + (t.input || "无"));
  L.push("- 产出：" + (t.output || "见验收标准"));
  L.push("- 预估：" + (t.est ? t.est + " 人天" : "—"));
  return L.join("\n");
}

/* 知识库必读清单：让任何模型开工前先读到项目上下文。
   路径写死成具体文件，比说一句「去看知识库」有效得多 */
function vaultRefs(t){
  var V = HDOCS + "/图谱/";
  var L = ["## 动手前先读这几篇（项目知识库）", ""];
  L.push("- `" + V + "任务/" + t.id + ".md`　本任务的完整卡片，以及前人留下的实施沉淀");
  L.push("- `" + V + "模块/" + t.module + ".md`　模块职责，以及已有代码在哪几个文件");
  (t.edges||[]).forEach(function(e){
    L.push("- `" + V + "边界/" + e + ".md`　本任务要兜的边界");
  });
  L.push("- `" + HDOCS + "/_MOC.md`　总索引，找别的东西从这里进");
  L.push("");
  L.push("笔记之间用 [[链接]] 互相引用，顺着链接走能找到相关的全部上下文。");
  return L.join("\n");
}

function buildImpl(t){
  var L = [];
  L.push("# 实现任务 " + t.id + "：" + t.title);
  L.push("");
  L.push("你负责实现这一个任务。只做这一个，别顺手改别处。");
  L.push("下面的信息够开工了；要更多上下文再去翻文档。");
  L.push("");
  L.push(promptHead(t));
  L.push(roleBlock(t, "impl"));
  L.push("");
  L.push(vaultRefs(t));
  L.push("");
  L.push("## 前置依赖");
  L.push(depBlock(t.deps));
  L.push("");
  L.push("## 验收标准（逐条都要满足，这是验收时的唯一依据）");
  acceptLines(t.accept).forEach(function(x){ L.push(x); });
  L.push("");
  L.push("## 必须处理的边界情况");
  L.push(edgeBlock(t.edges));
  var az = archBlock(t.module);
  if(az) L.push(az);
  var dz = designBlock(t.module);
  if(dz) L.push(dz);
  var ps = pathsOf(t.id);
  if(ps.length){
    L.push("");
    L.push("## 你只应改动这些路径");
    ps.forEach(function(p){ L.push("- " + p); });
    L.push("这个范围之外的文件不要动。别人可能正开着另一个会话在那里改，");
    L.push("你顺手改一笔，合并的时候就是冲突。确实非改不可，先停下说明理由。");
    var rv = rivalsOf(t.id);
    if(rv.length){
      L.push("");
      L.push("其中一些路径 " + rv.map(function(x){ return x.id; }).join("、") +
             " 也会碰到。如果它们正在并行开发，");
      L.push("别去动这些文件的公共结构（共享类型、路由注册表、全局配置）；");
      L.push("必须动就在回报里单独列出来，方便合并时排查。");
    }
  }
  var sk = skillBlock(t, "impl");
  if(sk) L.push(sk);
  L.push("");
  L.push("## 怎么干");
  if((t.deps||[]).length){
    L.push("1. 切到本任务这一层。它在栈上叠在 " + t.deps.join("、") + " 之上，二选一：");
    L.push("   gh stack add      " + hBranch(t.id) + "  # 这一层还没建，叠上去");
    L.push("   gh stack checkout " + hBranch(t.id) + "  # 这一层已经建好了，切进去");
    L.push("   别用 gh stack init——那是另起一条新栈，会把本任务从依赖链上摘下来。");
  }else{
    L.push("1. 切到本任务这一层。它没有前置依赖，就是本栈最底层：");
    L.push("   gh stack init     " + hBranch(t.id) + "  # 建栈并创建最底层");
    L.push("   gh stack checkout " + hBranch(t.id) + "  # 已经建过了就直接切进去");
  }
  L.push("2. 实现，然后逐条对着上面的验收标准和边界情况自检。");
  L.push("3. 提交并推送本层：");
  L.push("   git add -A");
  L.push('   git commit -m "' + t.id + " " + shq(t.title) + '"');
  L.push("   gh stack push");
  L.push("4. 回填知识库（见下面「交活前必须回填」），再交审查。");
  L.push("");
  L.push("落地由审查通过后统一 gh stack merge，不归你做。别自己合，也别碰别层的分支。");
  L.push("");
  L.push("## 交活前必须回填");
  L.push("");
  L.push("打开 `" + HDOCS + "/图谱/任务/" + t.id + ".md`，往两个受保护区块里写：");
  L.push("");
  L.push("```markdown");
  L.push("## 代码位置");
  L.push("<!-- code:begin -->");
  L.push("- `src/xxx/yyy.go:88-134` — 这段干什么" + (t.edges.length ? "（" + t.edges[0] + "）" : ""));
  L.push("<!-- code:end -->");
  L.push("");
  L.push("## 实施沉淀");
  L.push("<!-- notes:begin -->");
  L.push("为什么这么选、否掉了什么方案、踩了什么坑。");
  L.push("<!-- notes:end -->");
  L.push("```");
  L.push("");
  L.push("两条要求：");
  L.push("- 代码位置一行一处，格式 `路径:行号` — 说明。路径相对项目根，别写绝对路径。");
  L.push("- 实施沉淀写**代码里看不出来的东西**，不要复述代码干了什么。判断标准：");
  L.push("  三个月后有人想改这段代码，这条笔记能不能拦住他踩同一个坑。");
  L.push("");
  L.push("只写这两个标记之间，别动笔记的其它部分——那些是脚本从文档表格派生的。");
  L.push("写完跑一次：python _run/build_vault.py " + HDOCS);
  L.push("");
  L.push("## 不要做的事");
  L.push("- 不要改开发文档，也不要手改 `图谱/` 下笔记的正文（受保护区块除外）。");
  L.push("  觉得文档有问题，写进回报里，别自己动手。");
  L.push("- 不要实现别的任务，也不要提前做后面的。");
  L.push("- 不要引入技术栈之外的依赖。确实需要就先停下说明理由。");
  if(HO.conventions){ L.push(""); L.push("## 本项目约定"); L.push(HO.conventions); }
  L.push("");
  L.push("## 做完回报");
  L.push("改了哪些文件；每条验收标准分别落在哪个文件哪一行；每条边界情况做了什么处理；");
  L.push("知识库回填了没有；有没有偏离文档的地方。含糊的回报会被打回。");
  return L.join("\n");
}

function buildReview(t){
  var L = [];
  L.push("# 审查任务 " + t.id + "：" + t.title);
  L.push("");
  L.push("这个任务已经在栈分支 " + hBranch(t.id) + " 上实现完了，PR 已提。");
  L.push("请核它是不是真做到了。你只负责挑毛病和裁定，不要替它改代码。");
  L.push("");
  L.push(promptHead(t));
  L.push("- 前置依赖：" + ((t.deps||[]).join("、") || "无"));
  L.push(roleBlock(t, "review"));
  L.push("");
  L.push("## 验收标准（逐条核，这是唯一依据）");
  acceptLines(t.accept).forEach(function(x){ L.push(x); });
  L.push("");
  L.push("## 必须处理的边界情况（逐条去代码里找对应处理）");
  L.push(edgeBlock(t.edges));
  var az = archBlock(t.module);
  if(az) L.push(az);
  var dz = designBlock(t.module);
  if(dz) L.push(dz);
  var ps = pathsOf(t.id);
  if(ps.length){
    L.push("");
    L.push("## 这个任务被允许改动的路径");
    ps.forEach(function(p){ L.push("- " + p); });
    L.push("改到范围外的文件，即使改得对也要记进 OUT_OF_SCOPE——并行开发时那是合并冲突的来源。");
  }
  var sk = skillBlock(t, "review");
  if(sk) L.push(sk);
  L.push("");
  L.push("## 怎么审");
  L.push("1. 看这一层的改动：gh pr diff " + hBranch(t.id));
  L.push("   栈里每层的 PR 只显示它自己那一层，不含下层——这正是要审的范围。");
  L.push("2. 逐条验收标准，指出在哪个文件哪一行满足；指不出来就是不满足。");
  L.push("3. 逐条边界情况，指出代码里怎么处理的；找不到就是漏了。");
  L.push("4. 看有没有超出本任务范围的改动" + (ps.length ? "，特别是上面路径清单之外的文件" : "") + "。");
  L.push("5. 看有没有偏离文档约定（数据模型、接口约定、技术栈" +
         (az ? "、框架架构" : "") +
         (HO.design && isFrontend(t.module) ? "、视觉方向" : "") + "）。");
  L.push("6. 看知识库回填了没有：" + HDOCS + "/图谱/任务/" + t.id + ".md");
  L.push("7. 前六步都是打勾，打完再调 `dsh-code-review` 补一层语义评审。它管的是");
  L.push("   「做了，但做对了没」——上面每条都能指到代码，合起来仍然可能是错的。");
  L.push("   这一层的问题，逐条打勾永远发现不了。");
  if(isFrontend(t.module)){
    L.push("8. 这是界面任务，验收要有一段从真实服务录的 GIF，调 `record-browser-gif` 核它。");
    L.push("   没有 GIF 不算 pass：界面改动看不见实际效果，只能信实现方的自述。");
  }
  L.push("");
  L.push("## 输出格式（严格遵守）");
  L.push("VERDICT: pass | rework | doc-issue");
  L.push("ACCEPTANCE");
  L.push("- 1) 满足 → 文件:行　｜　不满足 → 缺什么");
  L.push("EDGES");
  L.push("- E-XX 已处理 → 文件:行　｜　未处理 → 缺什么");
  L.push("VAULT");
  L.push("- 代码位置：已回填 / 未回填　｜　实施沉淀：已回填 / 未回填");
  L.push("OUT_OF_SCOPE");
  L.push("- 超出本任务范围的改动；没有就写 none");
  L.push("DOC_ISSUE");
  L.push("- 问题出在文档本身（约定不清、跟别的章节打架、边界写了等于没写）；没有就写 none");
  L.push("REWORK");
  L.push("- 要改什么，一条一条写清楚，写成能直接粘回去让它返工的形式；pass 就写 none");
  L.push("");
  L.push("## 判完之后");
  L.push("pass 且 DOC_ISSUE 是 none —— 先回填知识库，再落地。");
  L.push("");
  L.push("回填 " + HDOCS + "/图谱/任务/" + t.id + ".md 里的两个受保护区块：");
  L.push("  代码位置（<!-- code:begin --> 之间）：一行一处，格式 `路径:行号` — 说明");
  L.push("  实施沉淀（<!-- notes:begin --> 之间）：为什么这么选、否掉了什么、踩了什么坑");
  L.push("                                        写代码里看不出来的，别复述代码干了什么");
  L.push("写完跑：python _run/build_vault.py " + HDOCS);
  L.push("没回填不得落地——知识库烂掉都是从「这次先不填」开始的。");
  L.push("回填的文字质量用 `dsh-prose-standard` 和 `dsh-trim-cot-leakage` 各核一遍。");
  L.push("");
  L.push("然后选证据集再落地：调 `dsh-pre-push-checks`，按这一层的改动挑最小充分");
  L.push("测试集——改了哪个模块就跑那个模块的测试。别无脑跑全量：代价不是慢，");
  L.push("是慢到后面每次都想跳过。");
  L.push("");
  L.push("证据过了整栈落地，不要一个个 PR 合。前后的约束见 `dsh-merging-stacked-prs`：");
  L.push("   gh stack merge <栈号或边界PR> --yes --merge");
  L.push("等每个 PR 都报 MERGED 才算落地，进了合并队列不算。");
  L.push("删分支单独走一趟，每条先确认没有别的 open PR 拿它当 base：");
  L.push("   gh pr list --state open --base " + hBranch(t.id) + " --json number --jq length");
  L.push("返回不是 0 就不许删——上面还压着一层，删了它的 base 就悬空。");
  L.push("rework —— 把 REWORK 段原样发回去返工，改完重审，不要自己下场改。");
  L.push("doc-issue —— 停手，先改文档。拿不准这段该写进哪一节就调 `dsh-doc-standards`。");
  L.push("             改完必须重跑 review.py、build_docs.py 与 build_vault.py——为什么");
  L.push("             产物不能手改、漏跑一个会怎样，见 `dsh-doc-site-sync`。");
  L.push("             然后用刷新后的实施提示词重做这个任务。");
  return L.join("\n");
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
  L.push("你负责按这套开发文档写代码。任务会一个一个发给你，每次只做一个。");
  L.push("这条是总交代，只发一次。");
  L.push("");
  L.push("## 项目");
  if(HO.stack) L.push("- 技术栈：" + HO.stack);
  L.push("- 开发文档：" + HDOCS);
  L.push("- 规模：" + mods.length + " 个模块 / " + tasks.length + " 个任务 / 合计 " + days + " 人天");
  L.push("");
  L.push("## 这个项目有知识库，别去通读文档");
  L.push("");
  L.push(HDOCS + " 同时是一个 Obsidian 知识库。每个模块、每个任务、每条边界");
  L.push("各有一篇笔记，互相用 [[链接]] 连着。**要什么顺着链接取什么，不要整本读**——");
  L.push("24 节文档全读一遍既慢又占地方，而且大半跟你手上这个任务无关。");
  L.push("");
  L.push("- `" + HDOCS + "/_MOC.md`　总索引。一页看完全貌，并告诉你查什么去哪找");
  L.push("- `" + HDOCS + "/图谱/任务/<任务ID>.md`　任务的完整卡片，含前人留下的实施沉淀");
  L.push("- `" + HDOCS + "/图谱/模块/<模块ID>.md`　模块职责，以及已有代码在哪几个文件");
  L.push("- `" + HDOCS + "/图谱/边界/<边界ID>.md`　某种异常该怎么处理");
  L.push("");
  L.push("## 先做这些（只做一次）");
  L.push("1. 读 `" + HDOCS + "/_MOC.md`，建立全貌。");
  L.push("2. 只有这两节需要整节读：02 非目标（决定什么坚决不做）、05 技术栈。");
  L.push("   其余按需顺链接取。");
  L.push("3. 按技术栈搭好工程骨架，初始化 git，提交一个基线。");
  L.push("4. 确认栈工具可用：gh stack --version");
  L.push("   不可用就停下来说一声，别退回 git merge——整套落地流程都建立在官方栈上。");
  L.push("");
  L.push("项目根的 AGENTS.md 里写着同一套规矩。你的工具如果会自动读它，那你已经知道了。");
  L.push("");
  L.push("## 你会用到这些技能");
  L.push("");
  L.push("每个任务的提示词都会点名该在哪一步调哪个技能、调了能拿到什么、不调会漏什么。");
  L.push("先把它们装上：");
  L.push("");
  L.push("- `gh-stack`　栈的命令细节与每条的非交互标志；不带标志会卡死在全屏 TUI，还不报错");
  L.push("- `dsh-prose-standard`　写实施沉淀时判断「写够了没有」——单纯变短不算改进");
  L.push("- `dsh-trim-cot-leakage`　沉淀写完过一遍，清掉只有当时在场的人才解析得了的话");
  if((HO.frontendModules||[]).length){
    L.push("- `record-browser-gif`　界面任务的验收证据：从真实服务录一段 GIF，不许 mock");
  }
  L.push("");
  L.push("除 `gh-stack` 外都来自 deepseek-harness 仓库的 `.agents/skills/`。");
  L.push("装不上也能干活——提示词里每一步做什么都写清了，只是拿不到完整判准。");
  L.push("");
  L.push("## 每个任务都适用的规矩");
  L.push("- 一个任务一层栈分支 " + HPRE + "<任务ID>，做完提交并 gh stack push，不自己合并。");
  L.push("- gh stack 的命令一律带非交互标志：view 用 --json、submit 用 --auto、");
  L.push("  merge 用 --yes。不带的话会开全屏 TUI 或等你回车，在自动跑批里就是卡死。");
  L.push("- 只做当前任务范围内的事，不提前做后面的。");
  L.push("- 不改开发文档，也不要手改 `图谱/` 下笔记的正文——那些是脚本从表格派生的，");
  L.push("  改了下次重跑就没。文档有问题就说出来，别自己动手。");
  L.push("- 验收标准和边界编号是硬指标，不是参考。每条都要能指到具体代码。");
  L.push("- 不引入技术栈之外的依赖。");
  L.push("- **做完要回填知识库**：把代码位置和实施要点写进");
  L.push("  `" + HDOCS + "/图谱/任务/<任务ID>.md` 的两个受保护区块（`<!-- code:begin -->`");
  L.push("  和 `<!-- notes:begin -->` 之间），然后才交审查。没回填不给落地。");
  L.push("");
  L.push("## 模块");
  mods.forEach(function(m){
    L.push("- " + m.id + "　" + m.role +
           ((m.deps||[]).length ? "（依赖 " + m.deps.join("、") + "）" : ""));
  });
  L.push("");
  L.push("## 开工顺序");
  L.push("第一批无前置依赖、可立即并行：" + (first.join("、") || "—"));
  L.push("完整依赖关系见 `" + HDOCS + "/_MOC.md` 的依赖全景图，");
  L.push("或阅读器概览页那张可点、可高亮关键路径的交互图。");
  if(HO.conventions){ L.push(""); L.push("## 本项目约定"); L.push(HO.conventions); }
  L.push("");
  L.push("准备好了回一句「就绪」，我发第一个任务。");
  return L.join("\n");
}

/* file:// 下 clipboard API 在部分浏览器不可用，必须留 execCommand 这条退路，
   否则双击打开的 HTML 上按钮全是死的 */
function copyText(txt, btn){
  function flash(ok){
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
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = txt; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch(e) { ok = false; }
    document.body.removeChild(ta);
    flash(ok);
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){ flash(true); }, fallback);
  } else fallback();
}

function promptFor(kind, id){
  if(kind === "kick") return buildKickoff();
  var t = taskById(id);
  if(!t) return "";
  return kind === "impl" ? buildImpl(t) : buildReview(t);
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
  var lv = layerOf(tasks.map(function(t){ return t.id; }), function(id){
    var t = taskById(id); return (t && t.deps) || [];
  });
  var by = {};
  tasks.forEach(function(t){ (by[lv[t.id]] = by[lv[t.id]] || []).push(t); });

  var done = tasks.filter(function(t){ return stOf(t.id) === "done"; }).length;
  var doing = tasks.filter(function(t){ return stOf(t.id) === "doing"; });
  var next = dispatchable();
  var nextIds = {};
  next.forEach(function(t){ nextIds[t.id] = 1; });

  var say;
  if(done === tasks.length){
    say = "<b>全部 " + tasks.length + " 个任务已落地。</b>";
  } else if(next.length){
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　现在可以同时开 <b>" + next.length +
          "</b> 个会话并行做：<em>" + next.map(function(t){ return t.id; }).join("　") + "</em>" +
          (next.length > 1 ? "　（这几个互不依赖，也不抢同一批文件）" : "");
  } else if(doing.length){
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　" + doing.length +
          " 个在跑（<em>" + doing.map(function(t){ return t.id; }).join("　") +
          "</em>）。剩下的都还等着它们，先把在跑的合了。";
  } else {
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　没有可派的任务了，检查是不是有依赖成环。";
  }

  var h = '<div class="kick">' +
    '<button class="cp big" data-kind="kick">复制开工总提示词</button>' +
    "<p>先把这条发给写代码的模型，一次性交代文档位置、技术栈、分支规矩和开工顺序。" +
    "之后按下面的顺序派活：复制「实施」发过去，它交活后复制同一行的「审查」做验收，" +
    "通过才落地。</p></div>" +
    '<div class="hnow"><span class="bar"><i style="width:' +
      (tasks.length ? Math.round(100 * done / tasks.length) : 0) + '%"></i></span>' +
      '<span class="txt">' + say + "</span>" +
      '<button class="rs" data-act="reset">重置进度</button></div>';

  Object.keys(by).map(Number).sort(function(a, b){ return a - b; }).forEach(function(k){
    var g = by[k].slice().sort(function(a, b){ return a.id.localeCompare(b.id); });
    var d = Math.round(g.reduce(function(s, x){ return s + (x.est||0); }, 0) * 10) / 10;
    var gd = g.filter(function(t){ return stOf(t.id) === "done"; }).length;
    h += '<div class="hbatch"><h5>第 ' + (k+1) + " 批 · " + g.length + " 个任务 · " + d + " 人天 · " +
         (k === 0 ? "无前置依赖，可立即开工" : "前面批次做完才能开始") +
         (gd ? " · 已落地 " + gd + "/" + g.length : "") + "</h5>";
    g.forEach(function(t){
      var id = esc(t.id), st = stOf(t.id), wait = waitingOn(t);
      var rv = rivalsOf(t.id).filter(function(x){
        return lv[x.id] === k && stOf(x.id) !== "done";
      });
      var cls = "htask " + st + (nextIds[t.id] ? " now" : "");
      h += '<div class="' + cls + '" data-t="' + id + '">' +
        '<button class="st" data-act="st" title="点一下换状态：待派 → 进行中 → 已落地">' +
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
          (wait.length ? " disabled title=\"依赖还没落地，派了也是白做\"" : "") + ">实施</button>" +
        '<button class="cp" data-kind="review" data-task="' + id + '">审查</button></div>';
    });
    h += "</div>";
  });
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
      var cls = "swbox" + (crit ? " crit" : "") + (r.st === "doing" ? " doing" : "");
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
  L.push("   git worktree add " + hTree(l+1));
  L.push("   cd " + hTree(l+1));
  L.push("窗口内部换任务用 gh stack checkout <分支>，不要再开新工作树。");
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
  var tasks = DT.tasks, done = tasks.filter(function(t){ return stOf(t.id) === "done"; }).length;
  var next = dispatchable();
  var say;
  if(done === tasks.length) say = "<b>全部 " + tasks.length + " 个任务已落地。</b>";
  else if(next.length)
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　现在可以同时开 <b>" +
          next.length + "</b> 个会话并行做：<em>" +
          next.slice(0, 5).map(function(t){ return t.id; }).join("　") +
          (next.length > 5 ? " …" : "") + "</em>";
  else
    say = "已落地 <b>" + done + "/" + tasks.length + "</b>　剩下的都在等前面的落地。";
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
  h += '<p class="hhint">每个任务一键复制出实施提示词发给写代码的模型，它交活后复制同一行的' +
       "审查提示词做验收，判通过才落地。提示词是自包含的——任务卡全字段、依赖任务标题、" +
       "涉及的每条边界定义都已内联，对方不翻文档也能开工。</p>";

  var sw = C.schedule();
  if(sw){
    h += '<section class="blk"><h2>并行窗口调度<span class="k">LANES</span></h2>' +
      '<p class="note">一条 lane 就是一个真开出来的会话窗口。排程同时受两条约束：' +
      "依赖层级管「谁必须等谁」，taskPaths 管「谁和谁会改同一个文件」——" +
      "后者依赖图完全看不见，只有排在这里才躲得开。</p>" + sw + "</section>";
  }
  h += '<section class="blk"><h2>按批次派活<span class="k">HANDOFF</span></h2>' +
    '<p class="note">批次按依赖层级自动算出，同一批内互不依赖。' +
    "点状态标签推进：待派 → 进行中 → 已落地；每推一格，上面的窗口调度和下面的可派集合一起重算。</p>" +
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
    "<span>点状态标签推进：待派 → 进行中 → 已落地；顶部会重算此刻能并发派哪几个</span>" +
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
  var ok = r.block === 0;
  el.className = "badge " + (ok ? "pass" : "fail");
  el.innerHTML = '<i class="dot"></i><span><b>' + (ok ? "审查通过" : r.block + " 项待修") +
    "</b>　边界覆盖 " + (r.coverage != null ? r.coverage + "%" : "—") + "</span>";
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
  var done = tasks.filter(function(t){ return stOf(t.id) === "done"; }).length;
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
              "deps": re.findall(r"M\d{1,2}-T\d{1,3}", cell(r, 3)),
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

    # 接口总表必须是 10 节第一张 4 列以上的表；字段级契约那类宽表只能排在它后面
    endpoints = [{"method": cell(r, 0), "path": cell(r, 1), "params": cell(r, 2),
                  "ret": cell(r, 3), "auth": cell(r, 4)}
                 for r in first_table(t10, 4)
                 if re.fullmatch(r"(GET|POST|PUT|PATCH|DELETE)", cell(r, 0), re.I)]

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
            "terms": terms, "endpoints": endpoints,
            "decisions": decisions, "changes": changes}


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


def orch_line(pres, blocks):
    if blocks:
        return "presentation.json（%d 块）" % len(blocks)
    if pres:
        return "默认排布（presentation.json 在，但没写 blocks）"
    return "默认（未提供 presentation.json）"


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print("需要传一个目录：" + root)
        return 2

    groups, by_num = collect(root)
    if not groups:
        print("目录下没找到任何分组子目录（应形如 00-概览/01-概述与目标.md）")
        return 2

    data = extract(by_num)

    pres = {}
    pp = os.path.join(root, "_run", "presentation.json")
    if os.path.exists(pp):
        try:
            pres = json.loads(read(pp))
        except ValueError as e:
            print("presentation.json 解析失败，退回默认编排：%s" % e)

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
            review = {"block": r.get("block", 0), "warn": r.get("warn", 0), "coverage": cov}
        except (ValueError, KeyError):
            pass

    payload = {
        "project": pres.get("project") or os.path.basename(os.path.abspath(root)),
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "review": review,
        "groups": groups,
        "data": data,
        "pres": pres,
        "index": chip_index(data),
    }

    with open(os.path.join(root, "docs-data.js"), "w", encoding="utf-8") as f:
        f.write("window.DOCS = " + json.dumps(payload, ensure_ascii=False) + ";\n")
    with open(os.path.join(root, "index.html"), "w", encoding="utf-8") as f:
        f.write(HTML)

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
        print("  任务提示词：%d 个任务，各一份实施 + 审查提示词%s"
              % (len(data["tasks"]),
                 "；handoff 缺 %s，这些位置退到通用默认值" % "、".join(miss) if miss else ""))
        if ho.get("design") and not ho.get("frontendModules"):
            print("  提示：handoff.design 写了视觉方向，但没写 frontendModules，前端任务拿不到它")

        arch = ho.get("architecture") or {}
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
