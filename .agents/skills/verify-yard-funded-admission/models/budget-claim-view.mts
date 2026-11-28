export const title = 'Reconcile an uncertain Yard budget execution claim';
export const state = v => {
 const label = v.phase==='quota-fenced' && !v.evidenceCurrent ? 'Budget execution evidence changed' : ({'budget-held':'Hosting budget reserved','claim-ack':'Budget execution claim acknowledged','claim-unknown':'Budget claim outcome unknown','reconciling':'Checking quota and budget evidence','quota-fenced':'Quota execution fence claimed','called':'Provider called'})[v.phase] ?? (v.writeFailed ? 'Budget uncertainty needs manual recording' : 'Budget hold marked uncertain');
 const faults=[];
 if(v.providerCalled && !v.evidenceCurrent) faults.push('budget evidence changed');
 if(v.phase==='stopped' && v.claimUnknown && !v.reported) faults.push('reconciliation not reported');
 if(v.phase==='stopped' && v.claimUnknown && v.budget!=='uncertain' && !v.writeFailed) faults.push('uncertainty not recorded');
 if(v.claimUnknown && v.providerCalled) faults.push('provider called before claim acknowledgement');
 return faults.length ? `${label}: ${faults.join(', ')}` : label;
};
export const step = action => ({ClaimAcknowledged:'claim budget execution',ClaimFakeEvidence:'accept unverified budget claim',ClaimLostCommitted:'report lost budget claim acknowledgement',ClaimLostEmpty:'report lost budget claim acknowledgement',CancelQuota:'release unused quota',CancelFailed:'retain quota for reconciliation',MarkUncertain:'mark budget uncertain',MarkFailed:'report unverified budget uncertainty',MarkFailedStored:'report unverified budget uncertainty',ClaimQuota:'claim quota execution',ChangeEvidence:'budget evidence changes',AbortChanged:'mark budget uncertain',AbortChangedUnverified:'report unverified budget uncertainty',CallProvider:'call provider',CallWithoutAck:'call provider without claim acknowledgement',Done:'finish'})[action] ?? null;
