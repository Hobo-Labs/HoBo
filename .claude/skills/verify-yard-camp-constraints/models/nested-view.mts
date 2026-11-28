export const title = 'Refuse unverified nested Camp layouts';
export const state = v => v.phase === 'received'
  ? ({match:'Yard matching requested',subset:'Layout comparison requested',plan:'Generation plan requested',saga:'Generation operation requested'})[v.entry]
  : v.phase === 'refused' ? 'Unverified nested Camp refused'
  : v.nested ? 'Unverified nested Camp accepted' : 'Request without nested Camps accepted';
export const step = (action, from, to) => ({
  Validate: to.phase === 'refused' ? 'refuse the nested Camp' : to.nested ? 'accept the unverified Camp' : 'accept the request',
  Done: 'finish',
})[action] ?? null;
