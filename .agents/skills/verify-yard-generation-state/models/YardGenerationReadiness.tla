----------------------- MODULE YardGenerationReadiness ---------------------
EXTENDS Naturals
CONSTANT CheckReady
VARIABLES resultReady, signalReady, signalBound, writeSucceeds, phase, hold, warning
vars == <<resultReady, signalReady, signalBound, writeSucceeds, phase, hold, warning>>
Init == /\ resultReady \in BOOLEAN /\ signalReady \in BOOLEAN /\ signalBound \in BOOLEAN
        /\ writeSucceeds \in BOOLEAN /\ phase = "result" /\ hold = "held" /\ warning = FALSE
Decide == /\ phase = "result"
          /\ IF ~resultReady /\ ~(signalReady /\ signalBound) /\ CheckReady
             THEN /\ phase' = "reconcile"
                  /\ hold' = IF writeSucceeds THEN "uncertain" ELSE "held"
                  /\ warning' = ~writeSucceeds
             ELSE /\ phase' = "placed" /\ UNCHANGED <<hold, warning>>
          /\ UNCHANGED <<resultReady, signalReady, signalBound, writeSucceeds>>
Done == /\ phase \in {"reconcile", "placed"} /\ UNCHANGED vars
Next == Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ resultReady \in BOOLEAN /\ signalReady \in BOOLEAN /\ signalBound \in BOOLEAN /\ writeSucceeds \in BOOLEAN
          /\ phase \in {"result", "reconcile", "placed"} /\ hold \in {"held", "uncertain"} /\ warning \in BOOLEAN
ReadyReceipt == phase = "placed" => (resultReady \/ (signalReady /\ signalBound))
ExposureRetained == phase = "reconcile" => hold \in {"held", "uncertain"}
WriteFailureReported == phase = "reconcile" /\ ~writeSucceeds => warning
=============================================================================
