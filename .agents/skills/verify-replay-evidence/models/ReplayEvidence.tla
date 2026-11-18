---------------------------- MODULE ReplayEvidence ----------------------------
\* One parsed report and caller attempts to mutate its input and output.
CONSTANTS Detach, FreezeVector, FreezeEntry, FreezeReport
VARIABLES phase, inputSeq, reportSeq, vectorIntact, markerIntact
vars == <<phase, inputSeq, reportSeq, vectorIntact, markerIntact>>
Init == /\ phase = "received" /\ inputSeq = "valid" /\ reportSeq = "none"
        /\ vectorIntact = TRUE /\ markerIntact = TRUE
Parse == /\ phase = "received" /\ phase' = "parsed"
         /\ reportSeq' = inputSeq
         /\ UNCHANGED <<inputSeq, vectorIntact, markerIntact>>
EditInput == /\ phase = "parsed" /\ inputSeq = "valid"
             /\ inputSeq' = "invalid"
             /\ reportSeq' = IF Detach THEN reportSeq ELSE "invalid"
             /\ UNCHANGED <<phase, vectorIntact, markerIntact>>
EditVector == /\ phase = "parsed" /\ vectorIntact /\ ~FreezeVector
              /\ vectorIntact' = FALSE
              /\ UNCHANGED <<phase, inputSeq, reportSeq, markerIntact>>
EditEntry == /\ phase = "parsed" /\ reportSeq = "valid" /\ ~FreezeEntry
             /\ reportSeq' = "invalid"
             /\ UNCHANGED <<phase, inputSeq, vectorIntact, markerIntact>>
EditMarker == /\ phase = "parsed" /\ markerIntact /\ ~FreezeReport
              /\ markerIntact' = FALSE
              /\ UNCHANGED <<phase, inputSeq, reportSeq, vectorIntact>>
Done == /\ phase = "parsed" /\ UNCHANGED vars
Next == Parse \/ EditInput \/ EditVector \/ EditEntry \/ EditMarker \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "parsed"}
          /\ inputSeq \in {"valid", "invalid"}
          /\ reportSeq \in {"none", "valid", "invalid"}
          /\ vectorIntact \in BOOLEAN /\ markerIntact \in BOOLEAN
EvidencePreserved == phase = "parsed" => reportSeq = "valid" /\ vectorIntact /\ markerIntact
=============================================================================
