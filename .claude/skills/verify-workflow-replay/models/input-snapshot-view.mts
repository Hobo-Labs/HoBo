export const title = 'Capture workflow input before execution';
export const state = (v) => {
  if (!v.valid && v.phase === 'captured') return 'Unreplayable input accepted';
  if (!v.valid && v.phase === 'recorded') return 'Unreplayable input recorded';
  if (!v.valid && v.phase === 'done') return 'Unreplayable input executed';
  if (v.phase === 'done' && v.effect !== v.journal) return 'Different input executed';
  return ({ new: 'Workflow input received', invalid: 'Unreplayable input refused', captured: 'Input captured', recorded: 'Journal bound to input', done: 'Captured work executed' })[v.phase];
};
export const step = (action, from, to) => ({
  Capture: !from.valid && to.phase === 'captured' ? 'accept unreplayable input' : 'capture and validate input',
  Mutate: 'caller edits retained input',
  Record: 'bind or read journal input',
  Effect: to.effect === to.journal ? 'execute captured input' : 'execute edited input',
  Done: 'wait',
})[action] ?? action;
