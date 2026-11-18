export const title = 'Update fuzz oracle capability';
export const state = (v) => {
  if (v.phase === 'new') return 'Capability update requested';
  if (v.phase === 'add-rejected') return 'Invalid capability rejected';
  if (v.phase === 'keep-rejected') return 'Invalid attenuation rejected';
  if (v.value.includes('other')) return 'Capability contains an unsupported verb';
  if (v.phase === 'attenuated' && v.keep.includes('other')) return 'Invalid attenuation accepted';
  if (v.phase === 'attenuated' && v.value.some((verb) => !v.prior.includes(verb))) return 'Capability widened';
  if (v.value.some((verb) => !v.replayed.includes(verb)) || v.replayed.some((verb) => !v.value.includes(verb))) return 'Capability differs from replay';
  if (v.phase === 'attenuated') return 'Capability attenuated';
  return 'Capability recorded';
};
export const step = (action, _from, to) => action === 'Add' ? (to.phase === 'add-rejected' ? 'reject invalid verbs' : 'record capability') : action === 'Attenuate' ? (to.phase === 'keep-rejected' ? 'reject invalid verbs' : 'attenuate capability') : ({ CallerEdit: 'caller edits supplied list', Wait: 'wait' })[action] ?? action;
