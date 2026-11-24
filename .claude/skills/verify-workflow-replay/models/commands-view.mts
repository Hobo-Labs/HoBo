export const title = 'Check recorded workflow commands';
export const state = v => {
 if (v.phase === 'rejected') return 'History diverged';
 if (v.phase === 'accepted') return 'History accepted';
 return v.cursor === 0 ? 'Checking command history' : 'Recorded prefix matched';
};
export const step = action => ({
 Consume:'check next command',
 Finish:'check for unused commands',
 Done:'finish',
})[action] ?? action;
