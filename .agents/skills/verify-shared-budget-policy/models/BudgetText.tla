----------------------------- MODULE BudgetText -----------------------------
CONSTANTS ValidateScope, ValidateTarget
VARIABLES kind, input, phase, encoded
vars == <<kind, input, phase, encoded>>

Inputs == {"ascii", "astral", "replacement", "high-surrogate", "low-surrogate"}
WellFormed == {"ascii", "astral", "replacement"}
Wire(value) == IF value \in WellFormed THEN value ELSE "replacement"

Init == /\ kind \in {"scope", "target"}
        /\ input \in Inputs
        /\ phase = "checking"
        /\ encoded = "none"

Evaluate == /\ phase = "checking"
            /\ LET validate == IF kind = "scope" THEN ValidateScope ELSE ValidateTarget
               IN IF input \notin WellFormed /\ validate
                     THEN /\ phase' = "refused"
                          /\ UNCHANGED encoded
                     ELSE /\ phase' = "accepted"
                          /\ encoded' = Wire(input)
            /\ UNCHANGED <<kind, input>>

Done == UNCHANGED vars
Next == Evaluate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in {"scope", "target"}
          /\ input \in Inputs
          /\ phase \in {"checking", "accepted", "refused"}
          /\ encoded \in Inputs \cup {"none"}
WirePreservesAcceptedText == phase = "accepted" => encoded = input
=============================================================================
