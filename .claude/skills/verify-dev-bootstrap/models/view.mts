export const title = 'Prepare the development toolchain';
export const state = (v) => {
  if (v.mode === 'invalid' && (v.attempts > 0 || v.selected !== 'none')) return 'Invalid path used';
  if (v.mode === 'override' && v.selected === 'system') return 'Wrong executable selected';
  if (v.phase === 'ready' && v.attempts > 0 && v.status === 'failed') return 'Failed installation accepted';
  if (v.phase === 'ready' && v.selected === 'target' && !v.present) return 'Missing executable accepted';
  if (v.phase === 'ready') return v.attempts > 0 ? 'Installed mise ready' : 'Existing mise ready';
  return ({ choosing: 'Bootstrap requested', rejected: 'Invalid path refused', installing: 'Installing selected mise', checking: 'Checking installer output', failed: 'Installation failed' })[v.phase];
};
export const step = (action, from, to) => ({
  Resolve: to.phase === 'rejected' ? 'reject invalid path' : to.phase === 'ready' && from.mode === 'override' && to.selected === 'system' ? 'use a different executable' : to.phase === 'ready' ? 'use existing executable' : 'install selected executable',
  InstallFailure: to.phase === 'installing' ? 'retry failed installation' : 'installer fails',
  InstallSuccess: 'installer reports success',
  CheckOutput: to.phase === 'ready' ? 'accept executable' : 'refuse missing executable',
  Done: 'wait',
})[action] ?? action;
