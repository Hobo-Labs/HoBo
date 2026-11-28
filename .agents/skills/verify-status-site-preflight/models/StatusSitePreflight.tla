------------------------- MODULE StatusSitePreflight -------------------------
EXTENDS Integers
CONSTANTS RequireAll, DeferRoot, StopOnInvalid
VARIABLES badAt, scanned, phase, touched, written
vars == <<badAt, scanned, phase, touched, written>>
Init == /\ badAt \in 0..2 /\ scanned = 0 /\ phase = "checking"
        /\ touched = FALSE /\ written = 0
Check == /\ phase = "checking" /\ scanned < 2
         /\ IF badAt = scanned + 1 /\ StopOnInvalid
               THEN /\ phase' = "rejected" /\ UNCHANGED scanned
               ELSE /\ scanned' = scanned + 1 /\ UNCHANGED phase
         /\ UNCHANGED <<badAt, touched, written>>
Prepare == /\ phase = "checking" /\ (scanned = 2 \/ (~RequireAll /\ scanned = 1))
           /\ phase' = "writing" /\ UNCHANGED <<badAt, scanned, touched, written>>
EarlyRoot == /\ ~DeferRoot /\ phase = "checking" /\ ~touched
             /\ touched' = TRUE /\ UNCHANGED <<badAt, scanned, phase, written>>
Write == /\ phase = "writing" /\ written < 2
         /\ touched' = TRUE /\ written' = written + 1
         /\ phase' = IF written' = 2 THEN "done" ELSE "writing"
         /\ UNCHANGED <<badAt, scanned>>
Wait == UNCHANGED vars
Next == Check \/ Prepare \/ EarlyRoot \/ Write \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ badAt \in 0..2 /\ scanned \in 0..2 /\ phase \in {"checking", "rejected", "writing", "done"}
          /\ touched \in BOOLEAN /\ written \in 0..2
NoChangesOnInvalid == badAt = 0 \/ ~touched
BarrierHonored == ~touched \/ scanned = 2
=============================================================================
