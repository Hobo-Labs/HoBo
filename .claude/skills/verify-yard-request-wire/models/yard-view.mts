export const title = 'Check an exact Yard request at the input boundary';
export const state = v => v.phase === 'received'
  ? (v.boundary === 'decoder' ? 'Binary request received' : 'CUE request received')
  : v.phase === 'refused' ? 'Invalid Yard request refused'
  : v.idState === 'blank' || (v.mode === 'exact' && v.idState === 'absent')
    ? 'Invalid Yard request accepted' : 'Valid Yard request accepted';
export const step = (action, from, to) => ({
  Validate: to.phase === 'refused' ? 'refuse the invalid Yard ID'
    : to.idState === 'blank' || (to.mode === 'exact' && to.idState === 'absent')
      ? 'accept an invalid Yard ID' : 'accept the Yard request',
  Done: 'finish',
})[action] ?? null;
