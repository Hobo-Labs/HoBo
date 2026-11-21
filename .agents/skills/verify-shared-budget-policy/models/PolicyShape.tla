------------------------ MODULE PolicyShape ------------------------
VARIABLES phase, constraints, accepted
vars == <<phase, constraints, accepted>>
Shapes == {"missing", "array", "null", "other"}
Init == /\ phase = "checking" /\ constraints \in Shapes /\ accepted = FALSE
Parse == /\ phase = "checking" /\ phase' = "parsed"
         /\ accepted' = (constraints \in {"missing", "array"})
         /\ UNCHANGED constraints
Done == /\ phase = "parsed" /\ UNCHANGED vars
Next == Parse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"checking", "parsed"} /\ constraints \in Shapes /\ accepted \in BOOLEAN
InvalidShapesRejected == phase = "parsed" /\ constraints \in {"null", "other"} => ~accepted
MissingMeansEmpty == phase = "parsed" /\ constraints = "missing" => accepted
=============================================================================
