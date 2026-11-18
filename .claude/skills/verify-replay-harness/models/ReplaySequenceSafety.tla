---------------------- MODULE ReplaySequenceSafety ----------------------
\* Abstract classes of numeric inputs for fold, replay and report parsing.
CONSTANTS CheckEvent, CheckTarget, CheckParsed
VARIABLES mode, event, target, phase, callback, report
vars == <<mode, event, target, phase, callback, report>>
Values == {"zero", "max", "negative", "fraction", "unsafe"}
Safe == {"zero", "max"}
Init == /\ mode \in {"fold", "replay", "parse"}
        /\ event \in Values /\ target \in Values
        /\ phase = "new" /\ callback = FALSE /\ report = FALSE
Validate == /\ phase = "new"
            /\ LET allowed == CASE mode = "fold" -> ((~CheckEvent \/ event \in Safe) /\ (~CheckTarget \/ target \in Safe))
                                      [] mode = "replay" -> (~CheckEvent \/ event \in Safe)
                                      [] OTHER -> (~CheckParsed \/ target \in Safe)
               IN phase' = IF allowed THEN "validated" ELSE "rejected"
            /\ UNCHANGED <<mode, event, target, callback, report>>
Execute == /\ phase = "validated" /\ phase' = "done"
           /\ callback' = (mode # "parse") /\ report' = TRUE
           /\ UNCHANGED <<mode, event, target>>
Done == UNCHANGED vars
Next == Validate \/ Execute \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"fold", "replay", "parse"}
          /\ event \in Values /\ target \in Values
          /\ phase \in {"new", "validated", "rejected", "done"}
          /\ callback \in BOOLEAN /\ report \in BOOLEAN
SafeBeforeCallback == callback => event \in Safe /\ (mode = "fold" => target \in Safe)
SafeParsedReport == report /\ mode = "parse" => target \in Safe
============================================================================
