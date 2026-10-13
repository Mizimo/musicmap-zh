export function deepseekBand(iso, pricing, override) {
  if (override && !['peak', 'offpeak'].includes(override)) throw new Error('Invalid DeepSeek price band');
  if (override) return override;
  const date = new Date(iso);
  if (!pricing.deepseekSchedule.verifiedNonHolidayDates.includes(iso.slice(0, 10))) {
    throw new Error('Check official pricing/calendar and set --deepseek-band peak|offpeak for this date');
  }
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return pricing.deepseekSchedule.peakWeekdays.includes(date.getUTCDay()) &&
    pricing.deepseekSchedule.peakHours.some(([a, b]) => hour >= a && hour < b) ? 'peak' : 'offpeak';
}

export function normalizeUsage(provider, raw) {
  if (!raw) return null;
  const number = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
  const input = number(provider === 'deepseek' ? raw.prompt_tokens : raw.input_tokens);
  const output = number(provider === 'deepseek' ? raw.completion_tokens : raw.output_tokens);
  const cacheRead = number(provider === 'deepseek' ? raw.prompt_cache_hit_tokens : raw.input_tokens_details?.cached_tokens);
  const cacheWrite = provider === 'deepseek' ? 0 : number(raw.input_tokens_details?.cache_write_tokens);
  const reasoning = number(provider === 'deepseek' ? raw.completion_tokens_details?.reasoning_tokens : raw.output_tokens_details?.reasoning_tokens);
  return {input, cacheRead, cacheWrite, output, reasoning, total: input === null || output === null ? null : input + output};
}

export function calculateCost({provider, model, usage, startedAt, finishedAt, serviceTier, pricing, bandOverride}) {
  if (!usage || usage.input === null || usage.output === null) return null;
  const modelPrice = pricing.models[model];
  if (!modelPrice) throw new Error('Unpriced model');
  if (provider === 'codex' && usage.input > 272000) throw new Error('Long-context pricing not supported by this small-passage benchmark');
  const notes = [];
  if (usage.reasoning === null) notes.push('Provider did not report reasoning tokens separately; they remain included in output.');
  const cacheMin = usage.cacheRead ?? 0;
  const cacheMax = usage.cacheRead ?? (usage.input - (usage.cacheWrite ?? 0));
  if (cacheMin > usage.input) throw new Error('Invalid cache usage');
  if (usage.cacheRead === null) notes.push('Cache reads not reported; cost is a bound, not an exact amount.');
  if (provider === 'deepseek') {
    const bands = [...new Set([deepseekBand(startedAt, pricing, bandOverride), deepseekBand(finishedAt || startedAt, pricing, bandOverride)])];
    if (bands.length > 1) notes.push('Request crossed a price-band boundary; bounds cover both published rates.');
    const compute = currency => {
      const amounts = bands.flatMap(band => [cacheMin,cacheMax].map(cached => {
        const p = modelPrice[currency][band];
        return ((usage.input - cached) * p.input + cached * p.cacheRead + usage.output * p.output) / 1e6;
      }));
      return {min:Math.min(...amounts),max:Math.max(...amounts)};
    };
    return {usd:compute('usd'),cny:compute('cny'),band:bands.join('/'),basis:'DeepSeek published-price estimate; invoice may differ',notes};
  }
  if (usage.cacheWrite === null) notes.push('Cache writes not reported: lower bound assumes none; upper bound treats all noncached input as cache writes.');
  if (serviceTier && serviceTier !== 'default') notes.push(`Returned service tier ${serviceTier}; equivalence below uses standard API rates only.`);
  const p = modelPrice.usd;
  const amounts = [cacheMin,cacheMax].flatMap(cached => {
    const writes = usage.cacheWrite === null ? [0,usage.input-cached] : [usage.cacheWrite];
    return writes.map(write => {
      if (write + cached > usage.input) throw new Error('Invalid cache usage');
      return ((usage.input-cached-write)*p.input+cached*p.cacheRead+write*p.cacheWrite+usage.output*p.output)/1e6;
    });
  });
  return {usd:{min:Math.min(...amounts),max:Math.max(...amounts)},basis:'Codex standard API-equivalent; not subscription debit',notes};
}
