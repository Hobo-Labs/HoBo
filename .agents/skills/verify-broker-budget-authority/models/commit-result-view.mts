export const title = 'Keep budget decisions closed after an uncertain commit';
export const state = (v) =>
	({
		ready: 'Budget change requested',
		accepted: 'Budget change acknowledged',
		uncertain: 'Commit uncertain, authority fenced',
		failed: 'Commit failed without acknowledgement',
	})[v.phase] ?? `Commit phase ${v.phase}`;
export const step = (action, from, to) => {
	if (action === 'Commit') {
		if (to.phase === 'accepted') return 'commit completes';
		if (to.phase === 'uncertain') return 'commit returns an ambiguous result';
		if (from?.kind?.startsWith('throw-') || from?.kind?.startsWith('denial-')) {
			return 'commit throws';
		}
		return 'commit completes';
	}
	if (action === 'Reuse') return 'reuse after uncertain or failed commit';
	if (action === 'CompletePending') return 'complete pending durability';
	return 'wait';
};