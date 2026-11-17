export const title = 'Serialize workflow journal appends';
export const state = v => {
 if (v.poisoned) return 'Append result uncertain';
 if (v.seq === 2) return 'Both appends acknowledged';
 if (v.writing.length > 0) return 'Appending one event';
 return v.seq === 0 ? 'Events queued' : 'One append acknowledged';
};
export const step = action => ({
 Begin:'start next append',
 Commit:'acknowledge append',
 Fail:'append fails or response is lost',
 Execute:'run authorized effect',
 Reject:'refuse queued append',
 Done:'finish',
})[action] ?? action;
