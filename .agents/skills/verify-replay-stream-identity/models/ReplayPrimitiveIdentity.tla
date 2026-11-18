------------------------- MODULE ReplayPrimitiveIdentity -------------------------
CONSTANTS CheckPrimitive, CheckNonEmpty
VARIABLES phase, field, value, accepted
vars == <<phase, field, value, accepted>>
Fields == {"run", "seed", "stream", "order"}
Values == {"valid", "empty", "boxed", "object"}
Init == /\ phase = "received" /\ field \in Fields /\ value \in Values /\ accepted = FALSE
Check == /\ phase = "received"
         /\ LET primitive == value \in {"valid", "empty"}
                nonempty == field = "order" \/ value # "empty"
                allowed == (~CheckPrimitive \/ primitive) /\ (~CheckNonEmpty \/ nonempty)
            IN /\ phase' = IF allowed THEN "accepted" ELSE "refused"
               /\ accepted' = allowed
         /\ UNCHANGED <<field, value>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Check \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "accepted", "refused"}
          /\ field \in Fields /\ value \in Values /\ accepted \in BOOLEAN
ValidIdentity == accepted => value \in {"valid", "empty"} /\ (field # "order" => value # "empty")
=============================================================================
