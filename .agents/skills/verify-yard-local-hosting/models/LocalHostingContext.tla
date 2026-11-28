----------------------- MODULE LocalHostingContext ---------------------------
EXTENDS Naturals
CONSTANTS CheckIdentities, CheckAuthorities, CheckEvidence, CheckFinal
VARIABLES identities, authorities, evidence, finalCurrent, phase
vars == <<identities, authorities, evidence, finalCurrent, phase>>
Init == /\ identities \in BOOLEAN /\ authorities \in BOOLEAN /\ evidence \in BOOLEAN
        /\ finalCurrent \in BOOLEAN /\ phase = "awaiting"
Current == /\ (IF CheckIdentities THEN identities ELSE TRUE)
           /\ (IF CheckAuthorities THEN authorities ELSE TRUE)
           /\ (IF CheckEvidence THEN evidence ELSE TRUE)
Check == /\ phase = "awaiting" /\ phase' = IF Current THEN "checked" ELSE "rejected"
         /\ UNCHANGED <<identities, authorities, evidence, finalCurrent>>
Finish == /\ phase = "checked" /\ phase' = IF finalCurrent \/ ~CheckFinal THEN "approved" ELSE "rejected"
          /\ UNCHANGED <<identities, authorities, evidence, finalCurrent>>
Done == /\ phase \in {"approved", "rejected"} /\ UNCHANGED vars
Next == Check \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ identities \in BOOLEAN /\ authorities \in BOOLEAN /\ evidence \in BOOLEAN /\ finalCurrent \in BOOLEAN
          /\ phase \in {"awaiting", "checked", "approved", "rejected"}
IdentitiesCurrent == phase = "approved" => identities
AuthoritiesCurrent == phase = "approved" => authorities
EvidenceCurrent == phase = "approved" => evidence
CurrentAtReceipt == phase = "approved" => finalCurrent
=============================================================================
