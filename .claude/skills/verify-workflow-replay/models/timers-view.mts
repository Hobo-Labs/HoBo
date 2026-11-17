export const title = 'Replay recorded workflow sleeps';
export const state = v => {
 if (v.phase === 'accepted') return 'Recorded sleeps match';
 if (v.phase === 'rejected') return 'Replay rejected';
 return v.cursor === 0 ? 'Checking recorded sleeps' : 'Matching sleep consumed';
};
export const step = action => ({
 Consume:'compare next sleep',
 Finish:'check for remaining sleeps',
 Done:'finish',
})[action] ?? action;
