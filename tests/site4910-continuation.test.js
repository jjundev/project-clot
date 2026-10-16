import './setup-env.js';
import{test}from'node:test';import assert from'node:assert/strict';
import{continueVerification}from'../scripts/4910-verification-continue.js';
const summary={date:'2026-10-16',total:100,pending:3};
test('complete runs do not queue more work',()=>{let calls=0;const r=continueVerification({summary:{...summary,pending:0},today:summary.date,run:()=>calls++});assert.equal(r.queued,false);assert.equal(calls,0);});
test('pending work dispatches a bounded next attempt on main',()=>{let invocation;const r=continueVerification({summary,today:summary.date,attempt:2,run:(...args)=>{invocation=args;return{status:0,stdout:'queued'};}});assert.equal(r.queued,true);assert.deepEqual(invocation.slice(0,2),['gh',['workflow','run','4910-full.yml','--ref','main','-f','continuation=3']]);});
test('stale dates, exhausted budgets and malformed counters never loop indefinitely',()=>{const run=()=>{throw Error('must not dispatch');};for(const extra of [{today:'2026-10-17'},{attempt:4},{attempt:-1},{summary:{...summary,pending:101}},{summary:{...summary,pending:NaN}}])assert.throws(()=>continueVerification({summary,today:summary.date,run,...extra}));});
test('dispatch failure is surfaced instead of reporting completion',()=>{assert.throws(()=>continueVerification({summary,today:summary.date,run:()=>({status:1,stderr:'denied'})}),/queue/);});
