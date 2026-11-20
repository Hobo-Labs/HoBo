-------------------- MODULE WorkflowResultSnapshot --------------------
EXTENDS Naturals
CONSTANTS CheckValid, SnapshotRecord, SnapshotReturn
VARIABLES phase, valid, source, captured, recorded, returned, edits
vars == <<phase, valid, source, captured, recorded, returned, edits>>

Init == /\ phase = "produced" /\ valid \in BOOLEAN
        /\ source = "before" /\ captured = "none" /\ recorded = "none"
        /\ returned = "none" /\ edits = 0

Capture == /\ phase = "produced"
           /\ IF valid \/ ~CheckValid
                 THEN /\ phase' = "captured" /\ captured' = source
                 ELSE /\ phase' = "rejected" /\ UNCHANGED captured
           /\ UNCHANGED <<valid, source, recorded, returned, edits>>

Mutate == /\ phase \in {"captured", "recorded", "returned", "crashed"}
          /\ edits = 0 /\ source' = "after" /\ edits' = 1
          /\ UNCHANGED <<phase, valid, captured, recorded, returned>>

Record == /\ phase = "captured" /\ phase' = "recorded"
          /\ recorded' = IF SnapshotRecord THEN captured ELSE source
          /\ UNCHANGED <<valid, source, captured, returned, edits>>

Return == /\ phase = "recorded" /\ phase' = "returned"
          /\ returned' = IF SnapshotReturn THEN captured ELSE source
          /\ UNCHANGED <<valid, source, captured, recorded, edits>>

Crash == /\ phase \in {"recorded", "returned"} /\ phase' = "crashed"
         /\ UNCHANGED <<valid, source, captured, recorded, returned, edits>>

Resume == /\ phase = "crashed" /\ phase' = "replayed" /\ returned' = recorded
          /\ UNCHANGED <<valid, source, captured, recorded, edits>>

Done == /\ phase \in {"rejected", "replayed"} /\ UNCHANGED vars
Next == Capture \/ Mutate \/ Record \/ Return \/ Crash \/ Resume \/ Done
Spec == Init /\ [][Next]_vars

NoInvalidCompletion == recorded # "none" => valid
RecordedFromCapture == recorded # "none" => recorded = captured
ReturnMatchesRecord == returned # "none" => returned = recorded
TypeOK == /\ phase \in {"produced", "captured", "rejected", "recorded", "returned", "crashed", "replayed"}
          /\ valid \in BOOLEAN /\ source \in {"before", "after"}
          /\ captured \in {"none", "before", "after"}
          /\ recorded \in {"none", "before", "after"}
          /\ returned \in {"none", "before", "after"} /\ edits \in 0..1
=============================================================================
