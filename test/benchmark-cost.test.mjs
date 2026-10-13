import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeUsage,calculateCost,deepseekBand} from '../lib/benchmark-cost.mjs';
const pricing=JSON.parse(await readFile(new URL('../benchmarks/pricing.json',import.meta.url)));
test('DeepSeek cache miss/hit and reasoning are charged once',()=>{
  const usage=normalizeUsage('deepseek',{prompt_tokens:1000,prompt_cache_hit_tokens:800,completion_tokens:200,completion_tokens_details:{reasoning_tokens:50}});
  const cost=calculateCost({provider:'deepseek',model:'deepseek-flash',usage,startedAt:'2026-10-13T09:00:00Z',pricing});
  assert.equal(usage.total,1200);
  assert.equal(cost.usd.min,(200*.3+800*.006+200*1.2)/1e6);
  assert.equal(cost.usd.min,cost.usd.max);
});
test('Codex cache writes are distinct; missing writes produce explicit bounds',()=>{
  const input={input_tokens:1000,input_tokens_details:{cached_tokens:600,cache_write_tokens:100},output_tokens:100,output_tokens_details:{reasoning_tokens:20}};
  const args={provider:'codex',model:'gpt-6.1-sol',pricing};
  const cost=calculateCost({...args,usage:normalizeUsage('codex',input)});
  assert.equal(cost.usd.min,(300*2+600*.1+100*2.5+100*10)/1e6);
  delete input.input_tokens_details.cache_write_tokens;
  const bound=calculateCost({...args,usage:normalizeUsage('codex',input)});
  assert.equal(bound.usd.min,(400*2+600*.1+100*10)/1e6);
  assert.equal(bound.usd.max,(400*2.5+600*.1+100*10)/1e6);
});
test('Peak boundaries and new dates require a checked calendar',()=>{
  assert.equal(deepseekBand('2026-10-13T10:00:00Z',pricing),'offpeak');
  assert.throws(()=>deepseekBand('2027-01-01T09:00:00Z',pricing),/calendar/);
  const cost=calculateCost({provider:'deepseek',model:'deepseek-flash',usage:{input:10,output:10,cacheRead:0,cacheWrite:0,reasoning:null},startedAt:'2026-10-13T09:59:00Z',finishedAt:'2026-10-13T10:01:00Z',pricing});
  assert.equal(cost.usd.max,cost.usd.min*2);
});
test('Unknown cache reads respect known writes; long context is never silently mispriced',()=>{
  const args={provider:'codex',model:'gpt-6.1-sol',pricing};
  const usage={input:1000,output:500,cacheRead:null,cacheWrite:200,reasoning:0};
  const cost=calculateCost({...args,usage});
  assert.equal(cost.usd.min,.00558);
  assert.equal(cost.usd.max,.0071);
  assert.throws(()=>calculateCost({...args,usage:{...usage,input:272001}}),/Long-context/);
});
