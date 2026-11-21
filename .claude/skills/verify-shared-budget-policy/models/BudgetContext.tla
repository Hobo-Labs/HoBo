--------------------------- MODULE BudgetContext ---------------------------
CONSTANTS ValidateContext, ValidateMeasurements
VARIABLES context, measurements, phase
vars == <<context, measurements, phase>>

Init == /\ context \in {"object", "invalid"}
        /\ measurements \in {"valid", "bad-collection", "bad-entry"}
        /\ phase = "checking"

Evaluate == /\ phase = "checking"
            /\ IF context = "invalid"
                  THEN phase' = IF ValidateContext THEN "refused" ELSE "crashed"
                  ELSE IF measurements # "valid"
                          THEN IF ValidateMeasurements
                                  THEN phase' = "refused"
                                  ELSE phase' \in {"accepted", "crashed"}
                          ELSE phase' = "accepted"
            /\ UNCHANGED <<context, measurements>>

Done == UNCHANGED vars
Next == Evaluate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ context \in {"object", "invalid"}
          /\ measurements \in {"valid", "bad-collection", "bad-entry"}
          /\ phase \in {"checking", "accepted", "refused", "crashed"}
InvalidMeasurementsRefused == phase = "accepted" => measurements = "valid"
InvalidContextRefused == phase = "accepted" => context = "object"
NoMalformedInputCrash == phase # "crashed"
=============================================================================
