---------------------- MODULE WorkflowRunIdBoundary ----------------------
CONSTANTS GuardId, SafeCheck
VARIABLES kind, phase, inspected
vars == <<kind, phase, inspected>>
Kinds == {"string-one", "string-two", "empty", "number", "boxed", "null", "proxy"}
Valid(k) == k \in {"string-one", "string-two"}
Stream(k) == CASE k \in {"string-one", "number", "boxed"} -> "run/1"
              [] k = "string-two" -> "run/2"
              [] k = "empty" -> "run/"
              [] OTHER -> "run/null"
Init == /\ kind \in Kinds /\ phase = "new" /\ inspected = FALSE
Check == /\ phase = "new"
         /\ phase' = IF ~Valid(kind) /\ GuardId THEN "invalid" ELSE "accepted"
         /\ inspected' = (inspected \/ (kind = "proxy" /\ ~SafeCheck))
         /\ UNCHANGED kind
Access == /\ phase = "accepted" /\ phase' = "accessed" /\ UNCHANGED <<kind, inspected>>
Done == UNCHANGED vars
Next == Check \/ Access \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in Kinds /\ phase \in {"new", "invalid", "accepted", "accessed"} /\ inspected \in BOOLEAN
NoInvalidAccess == phase \in {"accepted", "accessed"} => Valid(kind)
NoCoercedAlias == phase = "accessed" /\ Stream(kind) = "run/1" => kind = "string-one"
NoInvalidInspection == ~inspected
ValidIdAccepted == Valid(kind) => phase # "invalid"
=============================================================================
