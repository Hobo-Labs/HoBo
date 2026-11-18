export const title = 'Check Camp identity and requirements at the wire boundary';
const invalid = v => v.idState === 'blank' || (v.mode === 'exact' && v.idState === 'absent') || v.layoutState !== 'valid';
export const state = v => ({
  received: v.boundary === 'decoder' ? 'Binary request received' : 'CUE request received',
  refused: 'Invalid Camp request refused',
  accepted: invalid(v) ? 'Invalid Camp request accepted' : 'Valid Camp request accepted',
})[v.phase];
export const step = (action, from, to) => ({
  Validate: to.phase === 'refused' ? 'refuse invalid Camp input' : invalid(to) ? 'accept invalid Camp input' : 'accept valid Camp input',
  Done: 'finish',
})[action] ?? null;
