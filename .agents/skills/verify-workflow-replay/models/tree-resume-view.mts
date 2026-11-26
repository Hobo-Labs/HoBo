export const title = 'Resume nested workflow commands';
export const state = v => {
 if (v.poisoned) return 'History divergence stops execution';
 const active = v.active.length;
 const completed = Object.values(v.fact).filter(Boolean).length;
 if (active === 0 && completed === 0) return 'No child results recorded';
 if (active === 0 && completed === 2) return 'Both child results recorded';
 if (active === 0) return 'One child result recorded';
 return 'Parents recovering or running';
};
export const step = action => ({
 Enter:'enter or retry parent',
 Child:'reuse or record child',
 Close:'finish parent after child',
 Crash:'host stops parent',
 Diverge:'recorded child differs',
 Abort:'finish aborted execution',
})[action] ?? action;
