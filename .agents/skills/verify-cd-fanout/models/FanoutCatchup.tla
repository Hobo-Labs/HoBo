------------------------ MODULE FanoutCatchup ------------------------
EXTENDS Naturals
\* A missing slot is treated as pending. Other active states are abstracted.
VARIABLES pilot, production, catchUp, halted, free, phase, candidates, complete
vars == <<pilot, production, catchUp, halted, free, phase, candidates, complete>>
States == {"missing", "deferred", "succeeded", "failed"}
Init == /\ pilot \in States /\ production \in States
        /\ catchUp \in BOOLEAN /\ halted \in BOOLEAN /\ free \in BOOLEAN
        /\ phase = "ready" /\ candidates = {} /\ complete = FALSE
PilotReady == pilot \in {"missing", "deferred"}
ProductionReady == production \in {"missing", "deferred"}
PilotCandidates == IF PilotReady THEN {"pilot"} ELSE {}
ProductionCandidates == IF ProductionReady THEN {"production"} ELSE {}
CatchPilot == IF pilot = "deferred" THEN {"pilot"} ELSE {}
CatchProduction == IF production = "deferred" THEN {"production"} ELSE {}
Decide == /\ phase = "ready" /\ phase' = "decided"
          /\ candidates' =
              IF halted \/ ~free \/ (pilot = "failed" /\ ~catchUp) THEN {}
              ELSE IF catchUp THEN CatchPilot \cup (IF pilot = "succeeded" THEN CatchProduction ELSE {})
              ELSE IF pilot = "succeeded" THEN ProductionCandidates ELSE PilotCandidates
          /\ complete' = (pilot # "missing" /\ production # "missing")
          /\ UNCHANGED <<pilot, production, catchUp, halted, free>>
Done == /\ phase = "decided" /\ UNCHANGED vars
Next == Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ pilot \in States /\ production \in States /\ catchUp \in BOOLEAN
          /\ halted \in BOOLEAN /\ free \in BOOLEAN /\ phase \in {"ready", "decided"}
          /\ candidates \subseteq {"pilot", "production"} /\ complete \in BOOLEAN
MandatoryBeforeProduction == phase = "decided" /\ pilot # "succeeded" => "production" \notin candidates
MissingIsNotComplete == phase = "decided" /\ (pilot = "missing" \/ production = "missing") => ~complete
HaltSchedulesNothing == phase = "decided" /\ halted => candidates = {}
DeferredPilotCanCatchUp == phase = "decided" /\ catchUp /\ ~halted /\ free /\ pilot = "deferred" => "pilot" \in candidates
=============================================================================
