-------------------------- MODULE YardNestedCamp ---------------------------
EXTENDS Naturals
CONSTANTS CheckMatch, CheckSubset, CheckPlan, CheckSaga
VARIABLES nested, entry, phase
vars == <<nested, entry, phase>>
Guard == CASE entry = "match" -> CheckMatch
           [] entry = "subset" -> CheckSubset
           [] entry = "plan" -> CheckPlan
           [] OTHER -> CheckSaga
Init == /\ nested \in BOOLEAN /\ entry \in {"match", "subset", "plan", "saga"}
        /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF nested /\ Guard THEN "refused" ELSE "accepted"
            /\ UNCHANGED <<nested, entry>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ nested \in BOOLEAN /\ entry \in {"match", "subset", "plan", "saga"}
          /\ phase \in {"received", "accepted", "refused"}
NoUnsupportedDirect == phase = "accepted" => ~nested
ValidNotRefused == phase = "refused" => nested
=============================================================================
