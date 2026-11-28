----------------------- MODULE WorkflowRunIdentity -----------------------
\* One active run uses the primitive string "1". Values that stringify to
\* that stream can nevertheless be different JavaScript Map keys.
CONSTANTS CheckInput, CheckCollision
VARIABLES kind, phase
vars == <<kind, phase>>
Kinds == {"same", "other", "number", "boxed", "empty", "null"}
Valid(k) == k \in {"same", "other"}
Key(k) == CASE k = "same" -> "string-1"
           [] k = "other" -> "string-2"
           [] k = "number" -> "number-1"
           [] k = "boxed" -> "boxed-1"
           [] k = "empty" -> "empty-string"
           [] OTHER -> "null"
Stream(k) == CASE k \in {"same", "number", "boxed"} -> "1"
              [] k = "other" -> "2"
              [] k = "empty" -> ""
              [] OTHER -> "null"
Init == /\ kind \in Kinds /\ phase = "new"
Check == /\ phase = "new"
         /\ phase' = IF ~Valid(kind) /\ CheckInput THEN "invalid"
                      ELSE IF Key(kind) = "string-1" /\ CheckCollision THEN "conflict"
                      ELSE "accepted"
         /\ UNCHANGED kind
Effect == /\ phase = "accepted" /\ phase' = "effect" /\ UNCHANGED kind
Done == UNCHANGED vars
Next == Check \/ Effect \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == kind \in Kinds /\ phase \in {"new", "invalid", "conflict", "accepted", "effect"}
NoInvalidAdmission == phase \in {"accepted", "effect"} => Valid(kind)
NoAliasedEffect == phase = "effect" => Stream(kind) # "1"
OtherIdNotRefused == kind = "other" => phase \notin {"invalid", "conflict"}
============================================================================
