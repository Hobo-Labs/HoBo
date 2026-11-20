export const title = 'Signed settlement of a budget hold';
export const state = (v) => {
	if (v.phase === 'new') return 'No reservation';
	if (v.phase === 'released') return 'Unused hold released';
	if (v.phase === 'settled') return 'Final usage settled';
	if (v.phase === 'uncertain') {
		return v.claimed ? 'Uncertain claimed hold retained' : 'Uncertain unclaimed hold';
	}
	if (v.claimed) return 'Claimed hold retained';
	return v.unusedWitness ? 'Unused work confirmed' : 'Unclaimed hold';
};
export const step = (action) =>
	({
		Reserve: 'admit reservation',
		Claim: 'claim admitted execution',
		Settle: 'accept both signed proofs',
		ConfirmUnused: 'confirm unused work',
		Release: 'release unused hold',
		Uncertain: 'retain uncertain hold',
		Offer: 'inspect evidence',
		Done: 'wait',
	})[action] ?? action;