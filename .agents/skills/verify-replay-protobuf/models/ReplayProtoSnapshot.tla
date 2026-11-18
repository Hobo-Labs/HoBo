-------------------------- MODULE ReplayProtoSnapshot --------------------------
CONSTANT Capture
VARIABLES phase, source, snapshot, checked, decoded, edited
vars == <<phase, source, snapshot, checked, decoded, edited>>
Init == /\ phase = "received" /\ source = "first" /\ snapshot = "none"
        /\ checked = "none" /\ decoded = "none" /\ edited = FALSE
CaptureInput == /\ phase = "received" /\ phase' = "captured"
                /\ snapshot' = IF Capture THEN source ELSE "live"
                /\ UNCHANGED <<source, checked, decoded, edited>>
Check == /\ phase = "captured" /\ phase' = "checked"
         /\ checked' = IF Capture THEN snapshot ELSE source
         /\ UNCHANGED <<source, snapshot, decoded, edited>>
Edit == /\ phase = "checked" /\ ~edited
        /\ source' = "second" /\ edited' = TRUE
        /\ UNCHANGED <<phase, snapshot, checked, decoded>>
Decode == /\ phase = "checked" /\ phase' = "accepted"
          /\ decoded' = IF Capture THEN snapshot ELSE source
          /\ UNCHANGED <<source, snapshot, checked, edited>>
Done == /\ phase = "accepted" /\ UNCHANGED vars
Next == CaptureInput \/ Check \/ Edit \/ Decode \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "captured", "checked", "accepted"}
          /\ source \in {"first", "second"} /\ snapshot \in {"none", "live", "first"}
          /\ checked \in {"none", "first", "second"}
          /\ decoded \in {"none", "first", "second"} /\ edited \in BOOLEAN
CheckedMatchesDecoded == phase = "accepted" => checked = decoded
=============================================================================
