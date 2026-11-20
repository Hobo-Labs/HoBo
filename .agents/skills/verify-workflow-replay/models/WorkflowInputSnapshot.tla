---------------------- MODULE WorkflowInputSnapshot ----------------------
\* A captured journal input is detached from later caller edits. The model
\* treats ordinary JSON-tree validity and snapshot equality as trusted predicates.
CONSTANTS CheckInput, CheckSnapshot
VARIABLES valid, mode, caller, captured, journal, effect, phase
vars == <<valid, mode, caller, captured, journal, effect, phase>>
Init == /\ valid \in BOOLEAN /\ mode \in {"start", "resume"}
        /\ caller = "original" /\ captured = "none" /\ effect = "none"
        /\ journal = IF mode = "resume" THEN "original" ELSE "none"
        /\ phase = "new"
Capture == /\ phase = "new"
           /\ captured' = caller
           /\ phase' = IF ~valid /\ CheckInput THEN "invalid" ELSE "captured"
           /\ UNCHANGED <<valid, mode, caller, journal, effect>>
Mutate == /\ phase \in {"captured", "recorded"} /\ caller = "original"
          /\ caller' = "changed"
          /\ UNCHANGED <<valid, mode, captured, journal, effect, phase>>
Record == /\ phase = "captured"
          /\ journal' = IF mode = "start" THEN captured ELSE journal
          /\ phase' = "recorded" /\ UNCHANGED <<valid, mode, caller, captured, effect>>
Effect == /\ phase = "recorded"
          /\ effect' = IF CheckSnapshot THEN captured ELSE caller
          /\ phase' = "done" /\ UNCHANGED <<valid, mode, caller, captured, journal>>
Done == UNCHANGED vars
Next == Capture \/ Mutate \/ Record \/ Effect \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ valid \in BOOLEAN /\ mode \in {"start", "resume"}
          /\ caller \in {"original", "changed"} /\ captured \in {"none", "original"}
          /\ journal \in {"none", "original"} /\ effect \in {"none", "original", "changed"}
          /\ phase \in {"new", "invalid", "captured", "recorded", "done"}
EffectMatchesJournal == effect = "none" \/ effect = journal
NoInvalidEffect == effect # "none" => valid
NoInvalidRecord == mode = "start" /\ journal # "none" => valid
============================================================================
