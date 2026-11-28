---------------------- MODULE ReplayEventSnapshot ----------------------
\* One input event and a caller edit between the live and replay folds.
CONSTANTS SnapshotEvents, SnapshotReadSet
VARIABLES caller, captured, live, replay, readSet, phase
vars == <<caller, captured, live, replay, readSet, phase>>

Init == /\ caller = "original" /\ captured = "none" /\ live = "none"
        /\ replay = "none" /\ readSet = "none" /\ phase = "new"
Capture == /\ phase = "new" /\ captured' = caller /\ phase' = "captured"
           /\ UNCHANGED <<caller, live, replay, readSet>>
Live == /\ phase = "captured" /\ live' = captured /\ phase' = "live"
        /\ UNCHANGED <<caller, captured, replay, readSet>>
Mutate == /\ phase = "live" /\ caller = "original" /\ caller' = "changed"
          /\ UNCHANGED <<captured, live, replay, readSet, phase>>
Replay == /\ phase = "live"
          /\ replay' = IF SnapshotEvents THEN captured ELSE caller
          /\ phase' = "replayed" /\ UNCHANGED <<caller, captured, live, readSet>>
Report == /\ phase = "replayed"
          /\ readSet' = IF SnapshotReadSet THEN captured ELSE caller
          /\ phase' = "done" /\ UNCHANGED <<caller, captured, live, replay>>
Done == UNCHANGED vars
Next == Capture \/ Live \/ Mutate \/ Replay \/ Report \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ caller \in {"original", "changed"}
          /\ captured \in {"none", "original"} /\ live \in {"none", "original"}
          /\ replay \in {"none", "original", "changed"}
          /\ readSet \in {"none", "original", "changed"}
          /\ phase \in {"new", "captured", "live", "replayed", "done"}
FoldsMatch == replay # "none" => live = replay
ReadSetMatches == readSet # "none" => readSet = live
============================================================================
