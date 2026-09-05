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
vm.runInContext(`result = {}; (DT.tasks || []).forEach(function(t) {
  result[t.id] = {contractHash: D.handoff.contracts[t.id].hash,
    implementation: buildImpl(t), review: buildReview(t), resume: buildResume(t)};
});`, context, {timeout: 15000});
process.stdout.write(JSON.stringify(context.result));
