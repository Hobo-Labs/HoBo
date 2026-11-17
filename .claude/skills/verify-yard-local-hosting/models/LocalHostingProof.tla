------------------------ MODULE LocalHostingProof ----------------------------
EXTENDS Naturals
CONSTANTS CheckAuthority, CheckBinding, CheckPolicy, CheckObligations, CheckEvidence, CheckZero
VARIABLES authority, bound, allowed, obligations, evidence, zero, phase
facts == <<authority, bound, allowed, obligations, evidence, zero>>
vars == <<authority, bound, allowed, obligations, evidence, zero, phase>>
Init == /\ authority \in BOOLEAN /\ bound \in BOOLEAN /\ allowed \in BOOLEAN
        /\ obligations \in BOOLEAN /\ evidence \in BOOLEAN /\ zero \in BOOLEAN
        /\ phase = "pending"
Admissible == /\ (IF CheckAuthority THEN authority ELSE TRUE)
              /\ (IF CheckBinding THEN bound ELSE TRUE)
              /\ (IF CheckPolicy THEN allowed ELSE TRUE)
              /\ (IF CheckObligations THEN obligations ELSE TRUE)
              /\ (IF CheckEvidence THEN evidence ELSE TRUE)
              /\ (IF CheckZero THEN zero ELSE TRUE)
Evaluate == /\ phase = "pending" /\ phase' = IF Admissible THEN "approved" ELSE "rejected"
            /\ UNCHANGED facts
Done == /\ phase \in {"approved", "rejected"} /\ UNCHANGED vars
Next == Evaluate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ authority \in BOOLEAN /\ bound \in BOOLEAN /\ allowed \in BOOLEAN
          /\ obligations \in BOOLEAN /\ evidence \in BOOLEAN /\ zero \in BOOLEAN
          /\ phase \in {"pending", "approved", "rejected"}
HasAuthority == phase = "approved" => authority
BoundWork == phase = "approved" => bound
PolicyAllows == phase = "approved" => allowed
ObligationsMet == phase = "approved" => obligations
PolicyEvidence == phase = "approved" => evidence
ZeroLiability == phase = "approved" => zero
=============================================================================
