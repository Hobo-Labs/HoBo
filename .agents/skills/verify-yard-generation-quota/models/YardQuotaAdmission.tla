--------------------- MODULE YardQuotaAdmission ----------------------
EXTENDS Naturals
CONSTANTS CheckPresence, CheckPolicy, CheckQuota, CheckReady, CheckFinal
VARIABLES present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent
vars == <<present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent>>
Init == /\ present \in BOOLEAN /\ policyAllowed \in BOOLEAN /\ quotaAllowed \in BOOLEAN /\ readyEvidence \in BOOLEAN
        /\ phase = "received" /\ authorized = FALSE /\ quotaHeld = FALSE /\ budgetHeld = FALSE
        /\ providerCalled = FALSE /\ quotaReady = FALSE /\ uncertain = FALSE /\ authorityCurrent = TRUE
Start == /\ phase = "received"
         /\ phase' = IF ~present /\ CheckPresence THEN "quota-unavailable" ELSE "authorizing"
         /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent>>
Authorize == /\ phase = "authorizing"
             /\ phase' = IF policyAllowed \/ ~CheckPolicy THEN "authorized" ELSE "policy-denied"
             /\ authorized' = (policyAllowed \/ ~CheckPolicy)
             /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent>>
ReserveQuota == /\ phase = "authorized"
                /\ phase' = IF quotaAllowed \/ ~CheckQuota THEN "quota-held" ELSE "quota-denied"
                /\ quotaHeld' = (quotaAllowed \/ ~CheckQuota)
                /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, budgetHeld, providerCalled, quotaReady, uncertain, authorityCurrent>>
HoldBudget == /\ phase = "quota-held" /\ phase' = "budget-held" /\ budgetHeld' = TRUE
              /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, providerCalled, quotaReady, uncertain, authorityCurrent>>
ChangeAuthority == /\ phase = "budget-held" /\ authorityCurrent
                   /\ authorityCurrent' = FALSE
                   /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, phase, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, uncertain>>
Call == /\ phase = "budget-held" /\ (authorityCurrent \/ ~CheckFinal)
        /\ phase' = "called" /\ providerCalled' = TRUE
        /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, quotaReady, uncertain, authorityCurrent>>
Abort == /\ phase = "budget-held" /\ ~authorityCurrent /\ CheckFinal
         /\ phase' = "uncertain" /\ uncertain' = TRUE
         /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, quotaReady, authorityCurrent>>
Finish == /\ phase = "called"
          /\ phase' = IF readyEvidence \/ ~CheckReady THEN "ready" ELSE "uncertain"
          /\ quotaReady' = (readyEvidence \/ ~CheckReady)
          /\ uncertain' = (~readyEvidence /\ CheckReady)
          /\ UNCHANGED <<present, policyAllowed, quotaAllowed, readyEvidence, authorized, quotaHeld, budgetHeld, providerCalled, authorityCurrent>>
Done == /\ phase \in {"quota-unavailable", "policy-denied", "quota-denied", "ready", "uncertain"} /\ UNCHANGED vars
Next == Start \/ Authorize \/ ReserveQuota \/ HoldBudget \/ ChangeAuthority \/ Call \/ Abort \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ present \in BOOLEAN /\ policyAllowed \in BOOLEAN /\ quotaAllowed \in BOOLEAN /\ readyEvidence \in BOOLEAN
          /\ phase \in {"received", "quota-unavailable", "authorizing", "policy-denied", "authorized", "quota-denied", "quota-held", "budget-held", "called", "ready", "uncertain"}
          /\ authorized \in BOOLEAN /\ quotaHeld \in BOOLEAN /\ budgetHeld \in BOOLEAN /\ providerCalled \in BOOLEAN /\ quotaReady \in BOOLEAN /\ uncertain \in BOOLEAN /\ authorityCurrent \in BOOLEAN
NoQuotaWithoutAuthority == quotaHeld => present
NoQuotaWithoutPolicy == quotaHeld => policyAllowed
NoQuotaAboveLimit == quotaHeld => quotaAllowed
NoBudgetWithoutQuota == budgetHeld => quotaHeld
NoProviderWithoutFunding == providerCalled => quotaHeld /\ budgetHeld
NoProviderWithChangedAuthority == providerCalled => authorityCurrent
ReadyHasEvidence == quotaReady => readyEvidence
UncertainRetainsExposure == uncertain => quotaHeld /\ budgetHeld /\ ~quotaReady
=============================================================================
