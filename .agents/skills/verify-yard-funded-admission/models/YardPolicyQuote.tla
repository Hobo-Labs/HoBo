--------------------------- MODULE YardPolicyQuote ---------------------------
EXTENDS Naturals
CONSTANTS CheckId, CheckDigest
VARIABLES selected, approved, idMatches, phase
vars == <<selected, approved, idMatches, phase>>
Init == /\ selected \in {"A", "B"}
        /\ approved \in {"A", "B", "legacy"}
        /\ idMatches \in BOOLEAN
        /\ phase = "policy"
Authorize == /\ phase = "policy"
             /\ phase' = IF (idMatches \/ ~CheckId) /\ (approved = selected \/ ~CheckDigest)
                          THEN "issued" ELSE "rejected"
             /\ UNCHANGED <<selected, approved, idMatches>>
Done == /\ phase \in {"issued", "rejected"} /\ UNCHANGED vars
Next == Authorize \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ selected \in {"A", "B"} /\ approved \in {"A", "B", "legacy"}
          /\ idMatches \in BOOLEAN /\ phase \in {"policy", "issued", "rejected"}
BoundQuote == phase = "issued" => approved = selected
BoundId == phase = "issued" => idMatches
LegacyRejected == phase = "issued" => approved # "legacy"
=============================================================================
