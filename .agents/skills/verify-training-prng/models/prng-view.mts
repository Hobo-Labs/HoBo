export const title = 'Use a seeded generator';
export const state = (v) => v.phase === 'new' ? 'Seed supplied' : v.phase === 'refused' ? 'Invalid seed refused' : v.invalidSeen ? 'Invalid bound refused with stream unchanged' : 'Generator ready';
export const step = (action) => ({ Start: 'validate seed', Draw: 'draw value', InvalidBound: 'request invalid bound', Wait: 'wait' })[action] ?? action;
