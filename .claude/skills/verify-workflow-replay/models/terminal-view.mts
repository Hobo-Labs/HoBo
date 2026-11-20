export const title = 'Return a finished workflow outcome';
export const state = v => {
 if (v.phase === 'running') return 'Workflow running';
 if (v.phase === 'failed') return v.resumes > 0 ? 'Recorded failure returned' : 'Workflow failed';
 return v.resumes > 0 ? 'Recorded result returned' : 'Workflow completed';
};
export const step = action => ({
 Run:'execute workflow',
 Finish:'record terminal outcome',
 Resume:'return recorded outcome',
 Done:'finish',
})[action] ?? action;
