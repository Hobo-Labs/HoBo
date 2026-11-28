---------------------- MODULE ReplayTargetSnapshot ----------------------
\* One own target entry, optionally hidden, and a caller edit during a fold.
CONSTANTS CaptureHidden, UseSnapshot
VARIABLES hidden, caller, captured, selected, reported, phase
vars == <<hidden, caller, captured, selected, reported, phase>>

Init == /\ hidden \in BOOLEAN /\ caller = 1 /\ captured = 0
        /\ selected = 0 /\ reported = 0 /\ phase = "new"
Capture == /\ phase = "new"
           /\ captured' = IF CaptureHidden \/ ~hidden THEN caller ELSE 0
           /\ phase' = "captured" /\ UNCHANGED <<hidden, caller, selected, reported>>
Select == /\ phase = "captured" /\ selected' = captured /\ phase' = "selected"
          /\ UNCHANGED <<hidden, caller, captured, reported>>
Mutate == /\ phase = "selected" /\ caller = 1 /\ caller' = 2
          /\ UNCHANGED <<hidden, captured, selected, reported, phase>>
Report == /\ phase = "selected"
          /\ reported' = IF UseSnapshot THEN captured ELSE IF hidden THEN 0 ELSE caller
          /\ phase' = "done" /\ UNCHANGED <<hidden, caller, captured, selected>>
Done == UNCHANGED vars
Next == Capture \/ Select \/ Mutate \/ Report \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ hidden \in BOOLEAN /\ caller \in {1, 2} /\ captured \in {0, 1}
          /\ selected \in {0, 1} /\ reported \in {0, 1, 2}
          /\ phase \in {"new", "captured", "selected", "done"}
OwnTargetIncluded == phase \in {"selected", "done"} => selected = 1
ReportMatchesSelection == phase = "done" => reported = selected
============================================================================
