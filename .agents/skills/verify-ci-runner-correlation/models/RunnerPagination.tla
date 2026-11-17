------------------------- MODULE RunnerPagination -------------------------
EXTENDS Naturals
VARIABLES total, limit, activeAt, mode, phase, seen, found, result, allowed
vars == <<total, limit, activeAt, mode, phase, seen, found, result, allowed>>

Init == /\ total \in 0..3 /\ limit \in 1..2 /\ activeAt \in 0..total
        /\ mode \in {"strict", "force"} /\ phase = "scanning" /\ seen = 0
        /\ found = FALSE /\ result = "none" /\ allowed = FALSE
Observe == /\ phase = "scanning" /\ seen < total /\ seen < limit
           /\ seen' = seen + 1 /\ found' = (found \/ (activeAt = seen + 1))
           /\ UNCHANGED <<total, limit, activeAt, mode, phase, result, allowed>>
Exhaust == /\ phase = "scanning" /\ seen = total
           /\ phase' = "deciding" /\ result' = "complete"
           /\ UNCHANGED <<total, limit, activeAt, mode, seen, found, allowed>>
Truncate == /\ phase = "scanning" /\ seen = limit /\ seen < total
            /\ phase' = "deciding" /\ result' = "incomplete"
            /\ UNCHANGED <<total, limit, activeAt, mode, seen, found, allowed>>
Decide == /\ phase = "deciding" /\ phase' = "done"
          /\ allowed' = IF found THEN FALSE ELSE IF result = "incomplete" /\ mode = "strict" THEN FALSE ELSE TRUE
          /\ UNCHANGED <<total, limit, activeAt, mode, seen, found, result>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == Observe \/ Exhaust \/ Truncate \/ Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ total \in 0..3 /\ limit \in 1..2 /\ activeAt \in 0..total
          /\ mode \in {"strict", "force"} /\ phase \in {"scanning", "deciding", "done"}
          /\ seen \in 0..limit /\ found \in BOOLEAN /\ result \in {"none", "complete", "incomplete"} /\ allowed \in BOOLEAN
NoFalseComplete == result = "complete" => seen = total
FoundMatchesPrefix == found <=> (activeAt > 0 /\ activeAt <= seen)
NoObservedActiveTeardown == found => ~allowed
NoStrictMissedActive == phase = "done" /\ mode = "strict" /\ activeAt > 0 => ~allowed
=============================================================================
