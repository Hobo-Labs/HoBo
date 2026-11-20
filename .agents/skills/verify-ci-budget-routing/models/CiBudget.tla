----------------------------- MODULE CiBudget -----------------------------
EXTENDS Naturals
Cap == 2
VARIABLES phase, observed, active, local, decisionExposure
vars == <<phase, observed, active, local, decisionExposure>>
Init == /\ phase = "queued" /\ observed = 0 /\ active = 0 /\ local = 0
        /\ decisionExposure = 0
ReserveOther == /\ phase = "queued" /\ observed + active + local < Cap
                /\ active' = active + 1
                /\ UNCHANGED <<phase, observed, local, decisionExposure>>
CompleteOther == /\ phase = "queued" /\ active > 0
                 /\ active' = active - 1 /\ local' = local + 1
                 /\ UNCHANGED <<phase, observed, decisionExposure>>
NewerObservation == /\ phase = "queued" /\ local > 0
                    /\ observed' = observed + local /\ local' = 0
                    /\ UNCHANGED <<phase, active, decisionExposure>>
SameTimestamp == /\ phase = "queued" /\ local > 0 /\ UNCHANGED vars
Offer == /\ phase = "queued" /\ observed + active + local + 1 <= Cap
         /\ phase' = "offered" /\ decisionExposure' = observed + active + local + 1
         /\ UNCHANGED <<observed, active, local>>
Decline == /\ phase = "queued" /\ observed + active + local + 1 > Cap
           /\ phase' = "declined" /\ decisionExposure' = observed + active + local + 1
           /\ UNCHANGED <<observed, active, local>>
Done == /\ phase \in {"offered", "declined"} /\ UNCHANGED vars
Next == ReserveOther \/ CompleteOther \/ NewerObservation \/ SameTimestamp \/ Offer \/ Decline \/ Done
Spec == Init /\ [][Next]_vars
OfferFitsBudget == phase = "offered" => decisionExposure <= Cap
ExposureConserved == observed + active + local <= Cap
TypeOK == /\ phase \in {"queued", "offered", "declined"}
          /\ observed \in 0..Cap /\ active \in 0..Cap /\ local \in 0..Cap
          /\ decisionExposure \in 0..(Cap + 1)
=============================================================================
