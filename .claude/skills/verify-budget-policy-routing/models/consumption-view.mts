export const title = 'Validate reserved consumption before restoring capacity';
export const state = v => ({loaded:'Snapshot loaded',pending:'Reservation pending',rejected:'Snapshot rejected',released:'Consumption restored'})[v.phase];
export const step = action => ({Validate:'validate recorded consumption', Release:'release once', Done:'finish'})[action] ?? action;
