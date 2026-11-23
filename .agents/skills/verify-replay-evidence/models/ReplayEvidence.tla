---------------------------- MODULE ReplayEvidence ----------------------------
\* One parsed report and caller attempts to mutate its input and output.
CONSTANTS Detach, FreezeVector, FreezeEntry, FreezeReport
VARIABLES phase, inputSeq, reportSeq, vectorIntact, seedIntact
vars == <<phase, inputSeq, reportSeq, vectorIntact, seedIntact>>
Init == /\ phase = "received" /\ inputSeq = "valid" /\ reportSeq = "none"
        /\ vectorIntact = TRUE /\ seedIntact = TRUE
Parse == /\ phase = "received" /\ phase' = "parsed"
         /\ reportSeq' = inputSeq
         /\ UNCHANGED <<inputSeq, vectorIntact, seedIntact>>
EditInput == /\ phase = "parsed" /\ inputSeq = "valid"
             /\ inputSeq' = "invalid"
             /\ reportSeq' = IF Detach THEN reportSeq ELSE "invalid"
             /\ UNCHANGED <<phase, vectorIntact, seedIntact>>
EditVector == /\ phase = "parsed" /\ vectorIntact /\ ~FreezeVector
              /\ vectorIntact' = FALSE
              /\ UNCHANGED <<phase, inputSeq, reportSeq, seedIntact>>
EditEntry == /\ phase = "parsed" /\ reportSeq = "valid" /\ ~FreezeEntry
             /\ reportSeq' = "invalid"
             /\ UNCHANGED <<phase, inputSeq, vectorIntact, seedIntact>>
EditSeed == /\ phase = "parsed" /\ seedIntact /\ ~FreezeReport
              /\ seedIntact' = FALSE
              /\ UNCHANGED <<phase, inputSeq, reportSeq, vectorIntact>>
Done == /\ phase = "parsed" /\ UNCHANGED vars
Next == Parse \/ EditInput \/ EditVector \/ EditEntry \/ EditSeed \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "parsed"}
          /\ inputSeq \in {"valid", "invalid"}
          /\ reportSeq \in {"none", "valid", "invalid"}
          /\ vectorIntact \in BOOLEAN /\ seedIntact \in BOOLEAN
EvidencePreserved == phase = "parsed" => reportSeq = "valid" /\ vectorIntact /\ seedIntact
=============================================================================
