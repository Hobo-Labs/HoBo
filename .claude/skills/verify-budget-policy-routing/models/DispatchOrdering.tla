-------------------------- MODULE DispatchOrdering --------------------------
Locales == {"en", "sv"}
VARIABLES writer, reader, tied, legacy, phase, version, choice, replayed
vars == <<writer, reader, tied, legacy, phase, version, choice, replayed>>
LegacyChoice(locale) == IF ~tied THEN "cheapest" ELSE IF locale = "en" THEN "accent" ELSE "ascii"
NewChoice == IF tied THEN "ascii" ELSE "cheapest"
Init == /\ writer \in Locales /\ reader \in Locales /\ tied \in BOOLEAN /\ legacy \in BOOLEAN
        /\ phase = "ready" /\ version = "none" /\ choice = "none" /\ replayed = "none"
Select == /\ phase = "ready" /\ phase' = "recorded"
          /\ choice' = IF legacy THEN LegacyChoice(writer) ELSE NewChoice
          /\ version' = IF ~legacy /\ tied THEN "code-unit-v1" ELSE "none"
          /\ UNCHANGED <<writer, reader, tied, legacy, replayed>>
Replay == /\ phase = "recorded" /\ phase' = "replayed"
          /\ replayed' = IF version = "code-unit-v1" THEN NewChoice ELSE LegacyChoice(reader)
          /\ UNCHANGED <<writer, reader, tied, legacy, version, choice>>
Done == /\ phase = "replayed" /\ UNCHANGED vars
Next == Select \/ Replay \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ writer \in Locales /\ reader \in Locales /\ tied \in BOOLEAN /\ legacy \in BOOLEAN
          /\ phase \in {"ready", "recorded", "replayed"} /\ version \in {"none", "code-unit-v1"}
          /\ choice \in {"none", "cheapest", "accent", "ascii"}
          /\ replayed \in {"none", "cheapest", "accent", "ascii"}
NewSelectionStable == ~legacy /\ phase \in {"recorded", "replayed"} => choice = NewChoice
TieRecordsVersion == ~legacy /\ tied /\ phase \in {"recorded", "replayed"} => version = "code-unit-v1"
NewReplayStable == ~legacy /\ phase = "replayed" => replayed = choice
AllReplayStable == phase = "replayed" => replayed = choice
=============================================================================
