------------------------ MODULE YardRequestSnapshot --------------------------
EXTENDS Naturals
CONSTANT CopyRequest
VARIABLES caller, phase, boundId
vars == <<caller, phase, boundId>>
Init == /\ caller = "original" /\ phase = "evaluating" /\ boundId = "none"
Mutate == /\ phase = "evaluating" /\ caller = "original"
          /\ caller' = "changed" /\ UNCHANGED <<phase, boundId>>
Bind == /\ phase = "evaluating" /\ phase' = "bound"
        /\ boundId' = IF CopyRequest THEN "original" ELSE caller
        /\ UNCHANGED caller
Done == /\ phase = "bound" /\ UNCHANGED vars
Next == Mutate \/ Bind \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ caller \in {"original", "changed"}
          /\ phase \in {"evaluating", "bound"} /\ boundId \in {"none", "original", "changed"}
OriginalResource == phase = "bound" => boundId = "original"
=============================================================================
