export const title = 'Keep pricing authority current';
export const state = v => {
  if (v.phase === 'rejected') return 'Stale authority refused';
  if (v.phase === 'dispatched') return 'Delivery submitted';
  if (v.phase === 'ready') return v.current ? 'Receipt ready' : 'Authority changed before delivery';
  return v.current ? 'Resolution being checked' : 'Authority changed during resolution';
};
export const step = a => ({Revoke:'pricing authority changes',Issue:'issue receipt',RefuseReceipt:'refuse resolution',Dispatch:'submit delivery',RefuseDelivery:'refuse delivery',Done:'finish'})[a] ?? a;
