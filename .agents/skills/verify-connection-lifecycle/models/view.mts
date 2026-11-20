export const title = 'Connect and revoke a provider connection';
export const state = v => {
 if (v.usedAfterRevocation) return 'Revoked connection can be used';
 if (v.phase === 'absent') return 'No connection';
 if (v.phase === 'pending') return 'Awaiting authorization';
 if (v.phase === 'revoked') return 'Connection revoked';
 if (v.phase === 'needs-reauth') return v.revokedOnce ? 'Revoked connection needs authorization' : 'Authorization needs renewal';
 return v.revokedOnce ? 'Revoked connection authorized again' : 'Connection active';
};
export const step = action => ({Create:'create connection',Authorize:'authorize connection',Revoke:'revoke connection',NeedsReauth:'mark authorization expired',Rotate:'rotate credential',LateFact:'ignore a late event',Resolve:'request token',Done:'finish'})[action] ?? action;
