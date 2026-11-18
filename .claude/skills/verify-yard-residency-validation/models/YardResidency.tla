-------------------------- MODULE YardResidency --------------------------
EXTENDS Naturals
CONSTANT EarlyExplicit
VARIABLES tagValid, asserted, regionOK, phase
vars == <<tagValid, asserted, regionOK, phase>>
Init == /\ tagValid \in BOOLEAN /\ asserted \in BOOLEAN /\ regionOK \in BOOLEAN
        /\ phase = "review"
Check == /\ phase = "review"
         /\ phase' = IF asserted /\ EarlyExplicit THEN "eligible"
                     ELSE IF ~tagValid THEN "refused"
                     ELSE IF asserted \/ regionOK THEN "eligible" ELSE "refused"
         /\ UNCHANGED <<tagValid, asserted, regionOK>>
Done == /\ phase \in {"eligible", "refused"} /\ UNCHANGED vars
Next == Check \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ tagValid \in BOOLEAN /\ asserted \in BOOLEAN /\ regionOK \in BOOLEAN
          /\ phase \in {"review", "eligible", "refused"}
ValidResidency == phase = "eligible" => tagValid
EvidenceRequired == phase = "eligible" => asserted \/ regionOK
ValidExplicitAccepted == phase = "refused" /\ tagValid => ~asserted
=============================================================================
