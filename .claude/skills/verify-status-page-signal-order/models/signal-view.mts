export const title = 'Fold status measurements';
export const state = (v) => v.lastTime === -1 ? 'No accepted measurement' : v.lastTime === 0 ? 'Earlier measurement current' : 'Later measurement current';
export const step = (action) => ({ Sample: 'receive measurement', Wait: 'wait' })[action] ?? action;
