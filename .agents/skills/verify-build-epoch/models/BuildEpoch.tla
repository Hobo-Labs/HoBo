----------------------------- MODULE BuildEpoch -----------------------------
EXTENDS Integers
CONSTANTS RejectNegative, RejectLocal, RejectCalendar, RejectOverflow, PreserveEpoch
VARIABLES kind, lane, phase, normalized, received
vars == <<kind, lane, phase, normalized, received>>
Good == {"seconds", "iso"}
Kinds == Good \cup {"negative", "local", "calendar", "overflow"}
Lanes == {"synthetic", "component", "docker", "buildctl"}
Init == /\ kind \in Kinds /\ lane \in Lanes /\ phase = "requested"
        /\ normalized = -1 /\ received = -1
Permitted == kind \in Good \/ (kind = "negative" /\ ~RejectNegative)
          \/ (kind = "local" /\ ~RejectLocal)
          \/ (kind = "calendar" /\ ~RejectCalendar)
          \/ (kind = "overflow" /\ ~RejectOverflow)
Check == /\ phase = "requested"
         /\ phase' = IF Permitted THEN "ready" ELSE "rejected"
         /\ normalized' = IF Permitted THEN IF PreserveEpoch THEN 1 ELSE 0 ELSE -1
         /\ UNCHANGED <<kind, lane, received>>
Start == /\ phase = "ready" /\ phase' = "started"
         /\ received' = IF lane = "synthetic" THEN -1 ELSE normalized
         /\ UNCHANGED <<kind, lane, normalized>>
Wait == /\ phase \in {"rejected", "started"} /\ UNCHANGED vars
Next == Check \/ Start \/ Wait
Spec == Init /\ [][Next]_vars /\ WF_vars(Check) /\ WF_vars(Start)
TypeOK == /\ kind \in Kinds /\ lane \in Lanes
          /\ phase \in {"requested", "rejected", "ready", "started"}
          /\ normalized \in {-1, 0, 1} /\ received \in {-1, 0, 1}
OnlyValidAccepted == phase \notin {"ready", "started"} \/ kind \in Good
NoInvalidBuild == phase # "started" \/ kind \in Good
CorrectToolchainTime == phase # "started" \/ lane = "synthetic" \/ received = 1
EventuallyDecision == <> (phase # "requested")
=============================================================================
