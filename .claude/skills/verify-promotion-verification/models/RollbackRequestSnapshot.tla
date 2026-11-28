------------------- MODULE RollbackRequestSnapshot -------------------
\* After authorization, the caller can mutate its retained input object.
CONSTANT CheckSnapshot
VARIABLES caller, captured, authorized, effect, phase
vars == <<caller, captured, authorized, effect, phase>>
Init == /\ caller = "original" /\ captured = caller
        /\ authorized = "none" /\ effect = "none" /\ phase = "received"
Authorize == /\ phase = "received" /\ authorized' = captured
             /\ phase' = "authorized" /\ UNCHANGED <<caller, captured, effect>>
Mutate == /\ phase = "authorized" /\ caller = "original"
          /\ caller' = "changed" /\ UNCHANGED <<captured, authorized, effect, phase>>
Effect == /\ phase = "authorized"
          /\ effect' = IF CheckSnapshot THEN captured ELSE caller
          /\ phase' = "done" /\ UNCHANGED <<caller, captured, authorized>>
Done == UNCHANGED vars
Next == Authorize \/ Mutate \/ Effect \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ caller \in {"original", "changed"} /\ captured = "original"
          /\ authorized \in {"none", "original"} /\ effect \in {"none", "original", "changed"}
          /\ phase \in {"received", "authorized", "done"}
EffectMatchesAuthorization == effect = "none" \/ effect = authorized
=======================================================================
