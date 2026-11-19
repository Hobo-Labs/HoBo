export const title = 'Keep an active entitlement claim settleable';
const matches = (v) => v.bucketUnit === 'units' && v.bucketPeriod === 'p1';
export const state = (v) => {
	if (v.phase === 'new') return 'No reservation';
	if (v.phase === 'settled') return 'Usage settled';
	if (v.phase === 'released') return 'Unused reservation released';
	if (v.phase === 'uncertain')
		return v.claimed
			? 'Outcome uncertain; hold retained'
			: 'Outcome uncertain; hold retained';
	if (v.attempted) {
		return matches(v)
			? v.claimed
				? 'Scope change refused; claimed hold retained'
				: 'Scope change refused; hold retained'
			: v.claimed
				? 'Scope retargeted; claimed hold retained'
				: 'Scope retargeted; hold retained';
	}
	if (v.replay === 'accepted-invalid') return 'Incompatible replay accepted';
	if (v.replay === 'rejected') return 'Incompatible replay rejected';
	if (v.claimed) return 'Execution claimed; hold retained';
	return 'Hold reserved';
};
export const step = (action) =>
	({
		Reserve: 'reserve entitlement claim',
		Claim: 'claim execution',
		RecordZeroUnits: 'record zero-unit claim scope',
		Uncertain: 'execution outcome uncertain',
		ChangeScope: 'change or refuse entitlement scope',
		ReplayMismatch: 'replay entitlement evidence',
		Settle: 'settle final usage',
		ConfirmUnused: 'confirm unused reservation',
		Release: 'release unused reservation [before execution is claimed]',
		ChangeTerminalScope: 'change scope after finalization',
		Done: 'wait',
	})[action] ?? action;