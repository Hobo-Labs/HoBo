--------------------- MODULE YardGenerationPolicyGate ----------------------
EXTENDS Naturals
CONSTANTS CheckEffect, CheckApproval
VARIABLES effect, approval, phase, authorized, held, providerCalled
vars == <<effect, approval, phase, authorized, held, providerCalled>>
Init == /\ effect \in {"deny", "allow", "dedicated", "invalid"}
        /\ approval \in {"required", "not-required", "invalid"}
        /\ phase = "received" /\ authorized = FALSE /\ held = FALSE /\ providerCalled = FALSE
Decide == /\ phase = "received"
          /\ phase' = IF effect = "deny" \/ (effect # "allow" /\ CheckEffect)
                      THEN "effect-refused"
                      ELSE IF approval # "not-required" /\ CheckApproval
                           THEN "approval-refused" ELSE "planned"
          /\ UNCHANGED <<effect, approval, authorized, held, providerCalled>>
Authorize == /\ phase = "planned" /\ phase' = "authorized" /\ authorized' = TRUE
             /\ UNCHANGED <<effect, approval, held, providerCalled>>
Hold == /\ phase = "authorized" /\ phase' = "held" /\ held' = TRUE
        /\ UNCHANGED <<effect, approval, authorized, providerCalled>>
Call == /\ phase = "held" /\ phase' = "called" /\ providerCalled' = TRUE
        /\ UNCHANGED <<effect, approval, authorized, held>>
Done == /\ phase \in {"effect-refused", "approval-refused", "called"} /\ UNCHANGED vars
Next == Decide \/ Authorize \/ Hold \/ Call \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ effect \in {"deny", "allow", "dedicated", "invalid"}
          /\ approval \in {"required", "not-required", "invalid"}
          /\ phase \in {"received", "effect-refused", "approval-refused", "planned", "authorized", "held", "called"}
          /\ authorized \in BOOLEAN /\ held \in BOOLEAN /\ providerCalled \in BOOLEAN
NoUnsupportedPlan == phase \in {"planned", "authorized", "held", "called"} => effect = "allow"
NoUnapprovedPlan == phase \in {"planned", "authorized", "held", "called"} => approval = "not-required"
NoUnapprovedEffect == (authorized \/ held \/ providerCalled) => effect = "allow" /\ approval = "not-required"
ValidNotRefused == phase \in {"effect-refused", "approval-refused"} => effect # "allow" \/ approval # "not-required"
ProviderFunded == providerCalled => held
=============================================================================
