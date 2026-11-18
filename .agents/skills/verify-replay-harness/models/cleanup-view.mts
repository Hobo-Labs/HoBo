export const title = 'Restore replay test environment';
export const state = (v) => ({ 'install-clock': 'Replay check requested', 'install-random': 'Clock override installed', callback: 'Both overrides installed', 'restore-random': 'Fold finished or threw', 'restore-clock': 'Clock restoration pending', done: 'Overrides restored when possible' })[v.phase];
export const step = (action) => ({ InstallClock: 'install clock or stop', InstallRandom: 'install random or clean up', Callback: 'run fold', RestoreRandom: 'restore random', RestoreClock: 'restore clock', Done: 'wait' })[action] ?? action;
