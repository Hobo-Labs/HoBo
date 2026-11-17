export const title = 'Read the Yard runtime catalog';
export const state = v => v.phase === 'reading' ? 'Runtime catalog is being read' : v.phase === 'accepted' ? 'Runtime evidence available' : 'Unavailable runtime evidence refused';
export const step = (action, from, to) => action === 'Read' ? (to.phase === 'accepted' ? 'use current runtime evidence' : 'refuse unavailable evidence') : 'finish';
