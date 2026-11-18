export const title = 'Preserve and match JSON placement properties';
export const state = v => ({
  parse: 'Placement properties received',
  ready: 'Properties captured',
  done: v.matched ? 'Yard property compatible' : 'Yard property conflicts',
})[v.phase];
export const step = (action, from, to) => ({
  Parse: 'capture properties and labels',
  EditArray: 'caller changes captured properties',
  Match: to.matched ? 'accept equal or unconstrained properties' : 'refuse different properties',
  Done: 'finish',
})[action] ?? null;
