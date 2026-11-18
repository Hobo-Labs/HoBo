export const title = 'Return Yard generation outcomes to currently authorized callers';
export const state = v => {
  const base = ({pending:'Provider call pending', success:'Provider result retained', error:'Provider outcome uncertain'})[v.phase];
  const faults = [];
  if (v.leaked) faults.push('outcome disclosed without approval');
  if (v.deliveryPlan !== 'original') faults.push('authorization plan changed');
  if (v.phase === 'success' && v.cached !== 'ready') faults.push('result not retained');
  if (faults.length) return `${base}: ${faults.join(', ')}`;
  if (v.phase === 'pending') return base;
  return `${base}; ${v.lastOutcome === 'none' ? 'waiting for callers' : v.lastOutcome === 'returned' ? 'outcome returned' : 'caller refused'}`;
};
export const step = (action, from, to) => ({
 Revoke:'host revokes approval', Restore:'host restores approval',
 ProviderEdit:'provider changes its input copy', Complete:'provider result is recorded',
 ProviderError:'provider reply fails; retain the started attempt',
 Deliver:to.leaked ? 'disclose outcome without approval' : to.lastOutcome === 'returned' ? 'return the outcome with current approval' : 'refuse the caller',
 DeliverFirst:to.leaked ? 'disclose outcome without approval' : to.lastOutcome === 'returned' ? 'return the outcome with current approval' : 'refuse the caller',
 DeliverRetry:to.leaked ? 'disclose outcome without approval' : to.lastOutcome === 'returned' ? 'return the outcome with current approval' : 'refuse the caller',
 Done:'finish',
})[action] ?? null;
