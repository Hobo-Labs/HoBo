--------------------- MODULE YardQuotaAdmission ----------------------
EXTENDS Naturals
CONSTANTS CheckPresence, CheckPolicy, CheckQuota, CheckReady, CheckFinal, CheckExecution, CheckReserveAck
VARIABLES present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld,
          providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased
vars == <<present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld,
          providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
Init == /\ present \in BOOLEAN /\ policyAllowed \in BOOLEAN /\ quotaAllowed \in BOOLEAN /\ readyEvidence \in BOOLEAN
        /\ phase = "received" /\ authorized = FALSE /\ quotaHeld = FALSE /\ budgetHeld = FALSE
        /\ providerCalled = FALSE /\ quotaReady = FALSE /\ uncertain = FALSE /\ authorityCurrent = TRUE
        /\ quotaClaimed = FALSE /\ quotaReleased = FALSE
Start == /\ phase = "received"
         /\ phase' = IF ~present /\ CheckPresence THEN "quota-unavailable" ELSE "authorizing"
         /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
Authorize == /\ phase = "authorizing"
             /\ phase' = IF policyAllowed \/ ~CheckPolicy THEN "authorized" ELSE "policy-denied"
             /\ authorized' = (policyAllowed \/ ~CheckPolicy)
             /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
ReserveQuota == /\ phase = "authorized"
                /\ phase' = IF quotaAllowed \/ ~CheckQuota THEN "quota-held" ELSE "quota-denied"
                /\ quotaHeld' = (quotaAllowed \/ ~CheckQuota)
                /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
ReserveUnknownCommitted == /\ phase = "authorized" /\ (quotaAllowed \/ ~CheckQuota)
                           /\ phase' = "reserve-uncertain" /\ quotaHeld' = TRUE
                           /\ uncertain' = CheckReserveAck
                           /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, authorityCurrent, quotaClaimed, quotaReleased>>
ReserveUnknownEmpty == /\ phase = "authorized" /\ phase' = "reserve-uncertain"
                       /\ uncertain' = CheckReserveAck
                       /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, authorityCurrent, quotaClaimed, quotaReleased>>
HoldBudget == /\ phase = "quota-held" /\ phase' = "budget-held" /\ budgetHeld' = TRUE
              /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
ReleaseBeforeBudget == /\ phase = "quota-held" /\ phase' = "released" /\ quotaHeld' = FALSE /\ quotaReleased' = TRUE
                       /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed>>
ReleaseAfterBudget == /\ phase = "budget-held" /\ phase' = "budget-uncertain" /\ quotaHeld' = FALSE /\ quotaReleased' = TRUE /\ uncertain' = TRUE
                      /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, authorityCurrent, quotaClaimed>>
ReleaseFailed == /\ phase = "quota-held" /\ phase' = "quota-uncertain"
                 /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
ReleaseUnknown == /\ phase = "quota-held" /\ phase' = "quota-uncertain" /\ quotaHeld' = FALSE /\ quotaReleased' = TRUE
                  /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaClaimed>>
ClaimQuota == /\ phase = "budget-held" /\ authorityCurrent /\ phase' = "quota-claimed" /\ quotaClaimed' = TRUE
              /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent, quotaReleased>>
ChangeAuthority == /\ phase \in {"budget-held", "quota-claimed"} /\ authorityCurrent /\ authorityCurrent' = FALSE
                   /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, quotaClaimed, quotaReleased>>
Call == /\ phase \in {"budget-held", "quota-claimed"} /\ (quotaClaimed \/ ~CheckExecution) /\ (authorityCurrent \/ ~CheckFinal)
        /\ phase' = "called" /\ providerCalled' = TRUE
        /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, quotaReady, uncertain, authorityCurrent, quotaClaimed, quotaReleased>>
Abort == /\ phase = "quota-claimed" /\ ~authorityCurrent /\ CheckFinal /\ phase' = "uncertain" /\ uncertain' = TRUE
         /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, authorityCurrent, quotaClaimed, quotaReleased>>
Finish == /\ phase = "called"
          /\ phase' = IF readyEvidence \/ ~CheckReady THEN "ready" ELSE "uncertain"
          /\ quotaReady' = (readyEvidence \/ ~CheckReady) /\ uncertain' = (~readyEvidence /\ CheckReady)
          /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, authorityCurrent, quotaClaimed, quotaReleased>>
Done == /\ phase \in {"quota-unavailable", "policy-denied", "quota-denied", "reserve-uncertain", "released", "quota-uncertain", "budget-uncertain", "ready", "uncertain"} /\ UNCHANGED vars
Next == Start \/ Authorize \/ ReserveQuota \/ ReserveUnknownCommitted \/ ReserveUnknownEmpty \/ HoldBudget \/ ReleaseBeforeBudget \/ ReleaseAfterBudget \/ ReleaseFailed \/ ReleaseUnknown \/ ClaimQuota \/ ChangeAuthority \/ Call \/ Abort \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ present \in BOOLEAN /\ policyAllowed \in BOOLEAN /\ quotaAllowed \in BOOLEAN /\ readyEvidence \in BOOLEAN
          /\ phase \in {"received", "quota-unavailable", "authorizing", "policy-denied", "authorized", "quota-denied", "reserve-uncertain", "quota-held", "budget-held", "released", "quota-uncertain", "budget-uncertain", "quota-claimed", "called", "ready", "uncertain"}
          /\ authorized \in BOOLEAN /\ quotaHeld \in BOOLEAN /\ budgetHeld \in BOOLEAN /\ providerCalled \in BOOLEAN /\ quotaReady \in BOOLEAN /\ uncertain \in BOOLEAN /\ authorityCurrent \in BOOLEAN /\ quotaClaimed \in BOOLEAN /\ quotaReleased \in BOOLEAN
UnknownReservationReported == (phase = "reserve-uncertain") => uncertain
NoEffectsAfterUnknownReservation == (phase = "reserve-uncertain") => (~budgetHeld /\ ~providerCalled)
NoQuotaWithoutAuthority == quotaHeld => present
NoQuotaWithoutPolicy == quotaHeld => policyAllowed
NoQuotaAboveLimit == quotaHeld => quotaAllowed
NoBudgetWithoutQuotaOrRelease == budgetHeld => (quotaHeld \/ quotaReleased)
NoProviderWithoutFunding == providerCalled => quotaHeld /\ budgetHeld
NoProviderWithoutExecution == providerCalled => quotaClaimed
NoProviderWithChangedAuthority == providerCalled => authorityCurrent
ReadyHasEvidence == quotaReady => readyEvidence
NoReleaseAfterClaim == quotaReleased => (~quotaClaimed /\ ~providerCalled)
UncertainClaimRetainsExposure == (uncertain /\ quotaClaimed) => (quotaHeld /\ budgetHeld /\ ~quotaReady)
LegacyNoBudgetWithoutQuota == budgetHeld => quotaHeld
LegacyUncertainRetainsExposure == uncertain => (quotaHeld /\ budgetHeld /\ ~quotaReady)
=============================================================================
