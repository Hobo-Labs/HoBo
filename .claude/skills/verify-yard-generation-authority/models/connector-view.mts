export const title = 'Call the approved generation connector';
export const state = v => v.phase === 'checked' ? 'Approved connector checked' : v.called === 'approved' ? 'Approved connector called' : 'Different connector called';
export const step = (action, from, to) => action === 'Invoke' ? (to.called === 'approved' ? 'call the pinned connector' : 'registry redirects the call') : 'finish';
