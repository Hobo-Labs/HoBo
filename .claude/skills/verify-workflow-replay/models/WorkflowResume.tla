------------------------- MODULE WorkflowResume -------------------------
EXTENDS Naturals
VARIABLES phase, exists, sameInput, sameWorkflow, nameRecorded, seedRecorded,
          storedSeed, engineSeed, effectiveSeed, effects
vars == <<phase, exists, sameInput, sameWorkflow, nameRecorded, seedRecorded,
          storedSeed, engineSeed, effectiveSeed, effects>>
Init == /\ phase = "checking" /\ exists \in BOOLEAN /\ sameInput \in BOOLEAN
        /\ sameWorkflow \in BOOLEAN /\ nameRecorded \in BOOLEAN /\ seedRecorded \in BOOLEAN
        /\ storedSeed \in {"a", "b"} /\ engineSeed \in {"a", "b"}
        /\ effectiveSeed = "none" /\ effects = 0
Allowed == exists /\ sameInput /\ (~nameRecorded \/ sameWorkflow)
Resume == /\ phase = "checking"
          /\ phase' = IF Allowed THEN "running" ELSE "rejected"
          /\ effectiveSeed' = IF Allowed THEN (IF seedRecorded THEN storedSeed ELSE engineSeed) ELSE "none"
          /\ UNCHANGED <<exists, sameInput, sameWorkflow, nameRecorded, seedRecorded, storedSeed, engineSeed, effects>>
RunEffect == /\ phase = "running" /\ effects = 0 /\ effects' = 1
             /\ UNCHANGED <<phase, exists, sameInput, sameWorkflow, nameRecorded, seedRecorded, storedSeed, engineSeed, effectiveSeed>>
Done == /\ phase = "rejected" \/ (phase = "running" /\ effects = 1)
        /\ UNCHANGED vars
Next == Resume \/ RunEffect \/ Done
Spec == Init /\ [][Next]_vars
\* State the requirement independently of the guard so weakening Allowed is detectable.
NoEffectFromWrongRun == effects > 0 => (exists /\ sameInput /\ (~nameRecorded \/ sameWorkflow))
RecordedSeedIsPreserved == (phase = "running" /\ seedRecorded) => effectiveSeed = storedSeed
TypeOK == /\ phase \in {"checking", "running", "rejected"}
          /\ exists \in BOOLEAN /\ sameInput \in BOOLEAN /\ sameWorkflow \in BOOLEAN
          /\ nameRecorded \in BOOLEAN /\ seedRecorded \in BOOLEAN
          /\ storedSeed \in {"a", "b"} /\ engineSeed \in {"a", "b"}
          /\ effectiveSeed \in {"none", "a", "b"} /\ effects \in {0, 1}
=============================================================================
