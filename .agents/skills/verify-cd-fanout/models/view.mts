export const title = 'Promote a release through a pilot';
export const state = v => {
 if(v.halted) return 'Promotion halted';
 if(v.pilot === 'pending') return 'Pilot waiting';
 if(v.pilot === 'running') return 'Pilot deploying';
 if(v.pilot === 'failed') return 'Pilot failed';
 if(v.prod === 'pending') return 'Pilot passed';
 if(v.prod === 'running') return 'Production deploying';
 return v.prod === 'succeeded' ? 'Production promoted' : 'Production failed';
};
export const step = action => ({StartPilot:'start pilot',StartProd:'start production',PilotSucceeded:'pilot succeeds',PilotFailed:'pilot fails',ProdSucceeded:'production succeeds',ProdFailed:'production fails',Halt:'halt promotion',Resume:'resume promotion'})[action] ?? action;
