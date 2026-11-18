-------------------------- MODULE WorkflowJournalStream --------------------------
CONSTANTS CheckStream, Capture
VARIABLES phase, mode, liveForeign, capturedForeign, used, usedForeign, edited
vars == <<phase, mode, liveForeign, capturedForeign, used, usedForeign, edited>>
Modes == {"resume", "terminal", "replay", "journal"}
Init == /\ phase = "received" /\ mode \in Modes /\ liveForeign \in BOOLEAN
        /\ capturedForeign = FALSE /\ used = FALSE /\ usedForeign = FALSE /\ edited = FALSE
Check == /\ phase = "received"
         /\ capturedForeign' = liveForeign
         /\ phase' = IF liveForeign /\ CheckStream THEN "refused" ELSE "checked"
         /\ UNCHANGED <<mode, liveForeign, used, usedForeign, edited>>
Edit == /\ phase = "checked" /\ ~edited
        /\ liveForeign' = TRUE /\ edited' = TRUE
        /\ UNCHANGED <<phase, mode, capturedForeign, used, usedForeign>>
Use == /\ phase = "checked" /\ phase' = "done" /\ used' = TRUE
       /\ usedForeign' = IF Capture THEN capturedForeign ELSE liveForeign
       /\ UNCHANGED <<mode, liveForeign, capturedForeign, edited>>
Done == /\ phase \in {"done", "refused"} /\ UNCHANGED vars
Next == Check \/ Edit \/ Use \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "checked", "refused", "done"}
          /\ mode \in Modes /\ liveForeign \in BOOLEAN /\ capturedForeign \in BOOLEAN
          /\ used \in BOOLEAN /\ usedForeign \in BOOLEAN /\ edited \in BOOLEAN
NoForeignUse == used => ~usedForeign
=============================================================================
