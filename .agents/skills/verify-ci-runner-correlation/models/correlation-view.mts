export const title = 'Correlate a runner before teardown';
export const state = v => {
 if (v.stopped) return 'Runner may be stopped';
 if (v.selected === 'none') return 'Matching jobs observed';
 const status = v.selected === 'reserved' ? v.reserved : v.other;
 return status === 'executing' ? 'Executing job blocks teardown' : 'No executing job selected';
};
export const step = action => ({ Resolve:'select highest-priority job', Teardown:'allow teardown', Done:'finish' })[action] ?? action;
