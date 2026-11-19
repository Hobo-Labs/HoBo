export const title = 'Keep budget decisions closed after an uncertain commit';
export const state = (v) => ({
  ready: 'Budget change requested',
  accepted: 'Budget change acknowledged',
  uncertain: 'Commit uncertain, authority fenced',
})[v.phase];
export const step = (action, from, to) => action === 'Commit'
  ? (to.phase === 'accepted' ? 'commit completes' : from.kind.startsWith('throw-') ? 'commit throws' : 'commit returns an ambiguous result')
  : 'wait';
