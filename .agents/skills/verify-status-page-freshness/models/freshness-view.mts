export const title = 'Evaluate status signal freshness';
export const state = (v) => !v.evaluated ? 'Not evaluated' : v.verdict === 'fresh' ? 'Last report says fresh' : v.checkedAt < v.signal ? 'Signal was in the future at evaluation' : 'Signal was outside the freshness budget at evaluation';
export const step = (action) => ({ Advance: 'clock advances', Evaluate: 'evaluate signal', Wait: 'wait' })[action] ?? action;
