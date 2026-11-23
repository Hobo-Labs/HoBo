---------------------- MODULE WorkflowReplayBinding ----------------------
\* Replay with captured input and callbacks. Journal content,
\* equality, and the recorded identity are trusted abstract values.
CONSTANTS CheckInput, CheckName, CheckSeed, SnapshotInput, SnapshotCode
VARIABLES inputOK, nameOK, seedOK, caller, captured, codeChanged,
          usedInput, usedCode, phase
vars == <<inputOK, nameOK, seedOK, caller, captured, codeChanged,
          usedInput, usedCode, phase>>

Init == /\ inputOK \in BOOLEAN /\ nameOK \in BOOLEAN /\ seedOK \in BOOLEAN
        /\ caller = IF inputOK THEN "recorded" ELSE "different"
        /\ captured = "none" /\ codeChanged = FALSE
        /\ usedInput = "none" /\ usedCode = "none" /\ phase = "new"
Capture == /\ phase = "new"
           /\ captured' = caller /\ phase' = "captured"
           /\ UNCHANGED <<inputOK, nameOK, seedOK, caller, codeChanged, usedInput, usedCode>>
MutateCaller == /\ phase = "captured" /\ ~codeChanged
                /\ caller' = "changed" /\ codeChanged' = TRUE
                /\ UNCHANGED <<inputOK, nameOK, seedOK, captured, usedInput, usedCode, phase>>
Validate == /\ phase = "captured"
            /\ phase' = IF (CheckInput => inputOK) /\ (CheckName => nameOK) /\ (CheckSeed => seedOK)
                         THEN "verified" ELSE "rejected"
            /\ UNCHANGED <<inputOK, nameOK, seedOK, caller, captured, codeChanged, usedInput, usedCode>>
Execute == /\ phase = "verified"
           /\ usedInput' = IF SnapshotInput THEN captured ELSE caller
           /\ usedCode' = IF SnapshotCode \/ ~codeChanged THEN "original" ELSE "changed"
           /\ phase' = "done"
           /\ UNCHANGED <<inputOK, nameOK, seedOK, caller, captured, codeChanged>>
Done == UNCHANGED vars
Next == Capture \/ MutateCaller \/ Validate \/ Execute \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ inputOK \in BOOLEAN /\ nameOK \in BOOLEAN /\ seedOK \in BOOLEAN
          /\ caller \in {"recorded", "different", "changed"}
          /\ captured \in {"none", "recorded", "different"}
          /\ codeChanged \in BOOLEAN
          /\ usedInput \in {"none", "recorded", "different", "changed"}
          /\ usedCode \in {"none", "original", "changed"}
          /\ phase \in {"new", "captured", "verified", "rejected", "done"}
VerifiedContext == phase = "done" => inputOK /\ nameOK /\ seedOK
RecordedInput == phase = "done" => usedInput = "recorded"
CapturedCode == phase = "done" => usedCode = "original"
============================================================================
