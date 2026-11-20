export const title = 'Deliver a durable message';
export const state = v => {
 if (v.badAck) return 'Earlier receipt acknowledged replacement';
 if (v.phase === 'pending') return 'Message waiting';
 if (v.phase === 'acked') return 'Message acknowledged';
 if (v.expired) return 'Lease eligible for reclaim';
 return v.generation === 1 ? 'First delivery held' : 'Replacement delivery held';
};
export const step = (action, _from, to) => action === 'AckTracked' && to.badAck
 ? 'acknowledge with an earlier receipt'
 : ({
 Claim:'claim delivery',
 Remember:'retain a receipt',
 Expire:'visibility timeout passes',
 Reclaim:'reclaim with a new attempt',
 AckTracked:'acknowledge with matching receipt',
 AckCurrent:'acknowledge with current receipt',
 RefuseStale:'refuse an earlier receipt',
 Done:'finish',
})[action] ?? action;
