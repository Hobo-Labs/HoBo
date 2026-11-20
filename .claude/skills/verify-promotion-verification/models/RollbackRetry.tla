------------------------ MODULE RollbackRetry ------------------------
EXTENDS Naturals
\* The effect is abstractly atomic and changes the current Set. Rail effects,
\* simultaneous reads, and stores that reuse Set identifiers are not modeled.
VARIABLES claimed, base, current, effects, recorded
vars == <<claimed, base, current, effects, recorded>>
Init == /\ claimed = FALSE /\ base = "none" /\ current = "original"
        /\ effects = 0 /\ recorded = FALSE
Claim == /\ ~claimed /\ claimed' = TRUE /\ base' = current
         /\ UNCHANGED <<current, effects, recorded>>
Effect == /\ claimed /\ ~recorded /\ current = base /\ effects < 2
          /\ current' = "changed" /\ effects' = effects + 1
          /\ UNCHANGED <<claimed, base, recorded>>
Record == /\ effects > 0 /\ ~recorded /\ recorded' = TRUE
          /\ UNCHANGED <<claimed, base, current, effects>>
OtherChange == /\ claimed /\ effects = 0 /\ current = "original"
               /\ current' = "changed" /\ UNCHANGED <<claimed, base, effects, recorded>>
Done == UNCHANGED vars
Next == Claim \/ Effect \/ Record \/ OtherChange \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ claimed \in BOOLEAN /\ base \in {"none", "original", "changed"}
          /\ current \in {"original", "changed"} /\ effects \in 0..2 /\ recorded \in BOOLEAN
NoSecondSetChange == effects <= 1
ResultNeedsEffect == recorded => effects > 0
=============================================================================
