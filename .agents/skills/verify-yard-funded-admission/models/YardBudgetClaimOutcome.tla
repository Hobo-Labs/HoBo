-------------------- MODULE YardBudgetClaimOutcome ---------------------
EXTENDS Naturals
CONSTANTS CheckMark, CheckWarning, CheckFence, CheckEvidence, CheckBoundary
VARIABLES phase, budget, claimStored, claimUnknown, quotaHeld, quotaFenced,
          writeFailed, reported, providerCalled, evidenceCurrent
vars == <<phase, budget, claimStored, claimUnknown, quotaHeld, quotaFenced,
          writeFailed, reported, providerCalled, evidenceCurrent>>
Init == /\ phase = "budget-held" /\ budget = "held" /\ claimStored = FALSE
        /\ claimUnknown = FALSE /\ quotaHeld = TRUE /\ quotaFenced = FALSE
        /\ writeFailed = FALSE /\ reported = FALSE /\ providerCalled = FALSE /\ evidenceCurrent = TRUE
ClaimAcknowledged == /\ phase = "budget-held" /\ phase' = "claim-ack"
                     /\ claimStored' = TRUE
                     /\ UNCHANGED <<budget, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
ClaimFakeEvidence == /\ phase = "budget-held" /\ ~CheckEvidence /\ phase' = "claim-ack"
                     /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
ClaimLostCommitted == /\ phase = "budget-held" /\ phase' = "claim-unknown"
                      /\ claimStored' = TRUE /\ claimUnknown' = TRUE
                      /\ UNCHANGED <<budget, quotaHeld, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
ClaimLostEmpty == /\ phase = "budget-held" /\ phase' = "claim-unknown"
                  /\ claimUnknown' = TRUE
                  /\ UNCHANGED <<budget, claimStored, quotaHeld, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
CancelQuota == /\ phase = "claim-unknown" /\ phase' = "reconciling" /\ quotaHeld' = FALSE
               /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
CancelFailed == /\ phase = "claim-unknown" /\ phase' = "reconciling"
                /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, providerCalled, evidenceCurrent>>
MarkUncertain == /\ phase = "reconciling" /\ phase' = "stopped"
                 /\ budget' = IF CheckMark THEN "uncertain" ELSE "held"
                 /\ reported' = CheckWarning
                 /\ UNCHANGED <<claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, providerCalled, evidenceCurrent>>
MarkFailed == /\ phase = "reconciling" /\ phase' = "stopped"
              /\ writeFailed' = TRUE /\ reported' = CheckWarning
              /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, quotaFenced, providerCalled, evidenceCurrent>>
MarkFailedStored == /\ phase = "reconciling" /\ phase' = "stopped"
                    /\ budget' = "uncertain" /\ writeFailed' = TRUE /\ reported' = CheckWarning
                    /\ UNCHANGED <<claimStored, claimUnknown, quotaHeld, quotaFenced, providerCalled, evidenceCurrent>>
ClaimQuota == /\ phase = "claim-ack" /\ phase' = "quota-fenced" /\ quotaFenced' = TRUE
              /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, writeFailed, reported, providerCalled, evidenceCurrent>>
CallProvider == /\ phase = "quota-fenced" /\ (evidenceCurrent \/ ~CheckBoundary) /\ phase' = "called" /\ providerCalled' = TRUE
                /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, evidenceCurrent>>
ChangeEvidence == /\ phase = "quota-fenced" /\ evidenceCurrent /\ evidenceCurrent' = FALSE
                  /\ UNCHANGED <<phase, budget, claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, providerCalled>>
AbortChanged == /\ phase = "quota-fenced" /\ ~evidenceCurrent /\ phase' = "stopped"
                /\ budget' = "uncertain" /\ reported' = TRUE
                /\ UNCHANGED <<claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, providerCalled, evidenceCurrent>>
AbortChangedUnverified == /\ phase = "quota-fenced" /\ ~evidenceCurrent /\ phase' = "stopped"
                          /\ writeFailed' = TRUE /\ reported' = TRUE
                          /\ UNCHANGED <<budget, claimStored, claimUnknown, quotaHeld, quotaFenced, providerCalled, evidenceCurrent>>
CallWithoutAck == /\ phase = "claim-unknown" /\ ~CheckFence /\ providerCalled' = TRUE
                  /\ UNCHANGED <<phase, budget, claimStored, claimUnknown, quotaHeld, quotaFenced, writeFailed, reported, evidenceCurrent>>
Done == /\ phase \in {"stopped", "called"} /\ UNCHANGED vars
Next == ClaimAcknowledged \/ ClaimFakeEvidence \/ ClaimLostCommitted \/ ClaimLostEmpty \/ CancelQuota \/ CancelFailed \/ MarkUncertain \/ MarkFailed \/ MarkFailedStored \/ ClaimQuota \/ ChangeEvidence \/ AbortChanged \/ AbortChangedUnverified \/ CallProvider \/ CallWithoutAck \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"budget-held", "claim-ack", "claim-unknown", "reconciling", "stopped", "quota-fenced", "called"}
          /\ budget \in {"held", "uncertain"} /\ claimStored \in BOOLEAN /\ claimUnknown \in BOOLEAN
          /\ quotaHeld \in BOOLEAN /\ quotaFenced \in BOOLEAN /\ writeFailed \in BOOLEAN
          /\ reported \in BOOLEAN /\ providerCalled \in BOOLEAN /\ evidenceCurrent \in BOOLEAN
UnknownReported == (phase = "stopped" /\ claimUnknown) => reported
UncertaintyRecordedOrFailed == (phase = "stopped" /\ claimUnknown) => (budget = "uncertain" \/ writeFailed)
NoCallWithoutClaimAcknowledgement == claimUnknown => ~providerCalled
ProviderHasBothFences == providerCalled => (claimStored /\ quotaHeld /\ quotaFenced)
NoCallWithChangedEvidence == providerCalled => evidenceCurrent
NoReleaseAfterQuotaFence == quotaFenced => quotaHeld
=============================================================================
