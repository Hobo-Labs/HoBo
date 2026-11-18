------------------------- MODULE CampWirePresence -------------------------
EXTENDS Naturals
CONSTANTS CheckDomain, CheckCue
VARIABLES mode, idState, layoutState, boundary, phase
vars == <<mode, idState, layoutState, boundary, phase>>
Invalid == idState = "blank" \/ (mode = "exact" /\ idState = "absent") \/ layoutState # "valid"
Init == /\ mode \in {"exact", "compatible", "compatible-or-generate"}
        /\ idState \in {"absent", "blank", "nonblank"}
        /\ layoutState \in {"blank", "slash", "valid"} /\ boundary \in {"decoder", "cue"}
        /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF Invalid /\
                           (IF boundary = "decoder" THEN CheckDomain ELSE CheckCue)
                        THEN "refused" ELSE "accepted"
            /\ UNCHANGED <<mode, idState, layoutState, boundary>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"exact", "compatible", "compatible-or-generate"}
          /\ idState \in {"absent", "blank", "nonblank"}
          /\ layoutState \in {"blank", "slash", "valid"} /\ boundary \in {"decoder", "cue"}
          /\ phase \in {"received", "accepted", "refused"}
NoUnidentifiedExact == phase = "accepted" /\ mode = "exact" => idState = "nonblank"
NoInvalidCamp == phase = "accepted" => ~Invalid
ValidAccepted == phase = "refused" => Invalid
=============================================================================
