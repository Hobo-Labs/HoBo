---------------------------- MODULE YardQuotedWork ----------------------------
EXTENDS Naturals
CONSTANTS CheckWork, CheckClaimPlan, CheckEffectPlan, CheckFinalWork, MarkUncertain, ReportFailure
VARIABLES workMatches, claimPlanCurrent, effectPlanCurrent, finalWorkCurrent, markAvailable,
          phase, held, executed, uncertain, reported
facts == <<workMatches, claimPlanCurrent, effectPlanCurrent, finalWorkCurrent, markAvailable>>
vars == <<facts, phase, held, executed, uncertain, reported>>
Init == /\ workMatches \in BOOLEAN /\ claimPlanCurrent \in BOOLEAN /\ effectPlanCurrent \in BOOLEAN
        /\ finalWorkCurrent \in BOOLEAN /\ markAvailable \in BOOLEAN
        /\ phase = "policy" /\ held = FALSE /\ executed = FALSE /\ uncertain = FALSE /\ reported = FALSE
Reserve == /\ phase = "policy"
           /\ phase' = IF workMatches \/ ~CheckWork THEN "reserved" ELSE "rejected"
           /\ held' = (workMatches \/ ~CheckWork)
           /\ UNCHANGED <<facts, executed, uncertain, reported>>
Claim == /\ phase = "reserved"
         /\ phase' = IF claimPlanCurrent \/ ~CheckClaimPlan THEN "claimed" ELSE "rejected"
         /\ UNCHANGED <<facts, held, executed, uncertain, reported>>
Provision == /\ phase = "claimed"
             /\ phase' = IF effectPlanCurrent \/ ~CheckEffectPlan THEN "provisioned" ELSE "rejected"
             /\ executed' = (effectPlanCurrent \/ ~CheckEffectPlan)
             /\ UNCHANGED <<facts, held, uncertain, reported>>
Finalize == /\ phase = "provisioned"
            /\ phase' = IF finalWorkCurrent \/ ~CheckFinalWork THEN "issued" ELSE "rejected"
            /\ uncertain' = (~finalWorkCurrent /\ MarkUncertain /\ markAvailable)
            /\ reported' = (~finalWorkCurrent /\ ~markAvailable /\ ReportFailure)
            /\ UNCHANGED <<facts, held, executed>>
Done == /\ phase \in {"issued", "rejected"} /\ UNCHANGED vars
Next == Reserve \/ Claim \/ Provision \/ Finalize \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ workMatches \in BOOLEAN /\ claimPlanCurrent \in BOOLEAN /\ effectPlanCurrent \in BOOLEAN
          /\ finalWorkCurrent \in BOOLEAN /\ markAvailable \in BOOLEAN
          /\ held \in BOOLEAN /\ executed \in BOOLEAN /\ uncertain \in BOOLEAN /\ reported \in BOOLEAN
          /\ phase \in {"policy", "reserved", "claimed", "provisioned", "issued", "rejected"}
FundedWork == executed => held /\ workMatches
PlanAtClaim == executed => claimPlanCurrent
PlanAtEffect == executed => effectPlanCurrent
CurrentAtReceipt == phase = "issued" => finalWorkCurrent
ChangedWorkReconciled == executed /\ phase = "rejected" => held /\ (uncertain \/ reported)
=============================================================================
