import './setup-env.js';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {coverageGroup,countCoverage,evaluateFreshnessCoverage} from '../src/dashboard-coverage.js';
const H=3600000,AS_OF=Date.parse('2026-10-26T02:00:00Z');
test('coverage groups split wide, watched and 4910',()=>{
 assert.equal(coverageGroup({src:'musinsa',kind:'wide'}),'musinsa-wide');
 assert.equal(coverageGroup({src:'musinsa',kind:'liked'}),'musinsa-watched');
 assert.equal(coverageGroup({src:'musinsa',kind:'musinsa'}),'musinsa-watched');
 assert.equal(coverageGroup({src:'4910',kind:'scan'}),'4910');
});
test('countCoverage counts only ACTIVE tracking as active',()=>{
 const items=[{src:'musinsa',kind:'wide',tracking:{status:'ACTIVE'},on:true},{src:'musinsa',kind:'wide',tracking:{status:'ACTIVE'},on:false},{src:'musinsa',kind:'wide',tracking:{status:'STOPPED'},on:false}];
 assert.deepEqual(countCoverage(items,AS_OF,x=>x.on).get('musinsa-wide'),{active:2,live:1});
});
test('incident numbers collapse',()=>{
 assert.deepEqual(evaluateFreshnessCoverage([{key:'musinsa-wide',active:300677,live:0,lastRunAt:'2026-10-25T09:51:44.611Z'}],AS_OF),
  ['freshness coverage collapse: musinsa-wide live 0/300677 (last run 2026-10-25T09:51:44.611Z)']);
});
test('boundaries: 25% passes, small groups, stale, future and missing runs are skipped',()=>{
 const run=new Date(AS_OF-1*H).toISOString(),g=o=>[{key:'4910',active:1000,live:250,lastRunAt:run,...o}];
 assert.deepEqual(evaluateFreshnessCoverage(g(),AS_OF),[]);
 assert.equal(evaluateFreshnessCoverage(g({live:249}),AS_OF).length,1);
 assert.deepEqual(evaluateFreshnessCoverage(g({active:99,live:0}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF-48*H).toISOString()}),AS_OF).length,1);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF-48*H-1).toISOString()}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF+H).toISOString()}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:null}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:'2026-10-25'}),AS_OF),[]);
});
