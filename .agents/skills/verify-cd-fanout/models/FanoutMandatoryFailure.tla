--------------------- MODULE FanoutMandatoryFailure ---------------------
\* Two mandatory groups and production; slots are deferred or terminal.
CONSTANTS Camps, Mandatory
VARIABLES status, catchUp, phase, candidates
vars == <<status, catchUp, phase, candidates>>
States == {"deferred", "succeeded", "failed"}
Init == /\ status \in [Camps -> States] /\ catchUp \in BOOLEAN
        /\ phase = "ready" /\ candidates = {}
Failed == \E c \in Mandatory : status[c] = "failed"
Gate == \E c \in Mandatory : status[c] # "succeeded"
Eligible == {c \in Camps : status[c] = "deferred"}
Decide == /\ phase = "ready" /\ phase' = "decided"
          /\ candidates' = IF Failed THEN {}
                           ELSE IF Gate THEN Eligible \cap Mandatory ELSE Eligible
          /\ UNCHANGED <<status, catchUp>>
Done == /\ phase = "decided" /\ UNCHANGED vars
Next == Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in [Camps -> States] /\ catchUp \in BOOLEAN
          /\ phase \in {"ready", "decided"} /\ candidates \subseteq Camps
NoStartsAfterMandatoryFailure == phase = "decided" /\ Failed => candidates = {}
AvailableMandatoryCanRun ==
  phase = "decided" /\ ~Failed /\ status["pilot"] = "deferred"
    => "pilot" \in candidates
=============================================================================
