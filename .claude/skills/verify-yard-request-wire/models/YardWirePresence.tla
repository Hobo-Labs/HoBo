------------------------- MODULE YardWirePresence -------------------------
EXTENDS Naturals
CONSTANTS DomainExact, DomainBlank, CueExact, CueBlank
VARIABLES mode, idState, boundary, phase
vars == <<mode, idState, boundary, phase>>
InvalidExact == mode = "exact" /\ idState = "absent"
InvalidBlank == idState = "blank"
Invalid == InvalidExact \/ InvalidBlank
Init == /\ mode \in {"exact", "compatible", "compatible-or-generate"}
        /\ idState \in {"absent", "blank", "nonblank"}
        /\ boundary \in {"decoder", "cue"}
        /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF (InvalidExact /\ (IF boundary = "decoder" THEN DomainExact ELSE CueExact)) \/
                            (InvalidBlank /\ (IF boundary = "decoder" THEN DomainBlank ELSE CueBlank))
                        THEN "refused" ELSE "accepted"
            /\ UNCHANGED <<mode, idState, boundary>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"exact", "compatible", "compatible-or-generate"}
          /\ idState \in {"absent", "blank", "nonblank"}
          /\ boundary \in {"decoder", "cue"}
          /\ phase \in {"received", "accepted", "refused"}
NoUnidentifiedExact == phase = "accepted" /\ mode = "exact" => idState = "nonblank"
NoBlankId == phase = "accepted" => idState # "blank"
ValidAccepted == phase = "refused" => Invalid
=============================================================================
