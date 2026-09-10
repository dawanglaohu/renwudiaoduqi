// The browser and exported dispatch package execute the same prompt functions.
// No project JavaScript is evaluated: only JSON data enters this fixed sandbox.
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const context = {
  D: input.payload, DT: input.payload.data, PR: input.payload.pres,
  window: {PROGRESS: {}}, localStorage: {getItem: () => null},
  esc: value => String(value == null ? '' : value)
};
vm.createContext(context, {codeGeneration: {strings: false, wasm: false}});
vm.runInContext(input.core, context, {timeout: 5000});
vm.runInContext(`result = {tasks: {}, batches: {}}; (DT.tasks || []).forEach(function(t) {
  result.tasks[t.id] = {contractHash: D.handoff.contracts[t.id].hash,
    implementation: buildImpl(t), review: buildReview(t), resume: buildResume(t)};
});
// 每批一份收口提示词：batchPrompt 是纯函数，不看进度也不看收口记录；tasks 排序后导出，下游按集合匹配本批
var BL = batchLayers();
Object.keys(BL.by).forEach(function(k) {
  result.batches[k] = {batchNo: Number(k) + 1,
    tasks: BL.by[k].map(function(t) { return t.id; }), wrapup: batchPrompt(Number(k))};
});`, context, {timeout: 15000});
process.stdout.write(JSON.stringify(context.result));
