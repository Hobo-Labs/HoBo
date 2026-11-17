------------------------ MODULE RunnerQueuedClock ------------------------
VARIABLES source, clock, phase, blocked
vars == <<source, clock, phase, blocked>>
Init == /\ source \in {"scan", "direct"} /\ clock \in {"invalid", "recent", "expired"}
        /\ phase = "observed" /\ blocked = FALSE
Decide == /\ phase = "observed" /\ phase' = "decided"
          /\ blocked' = (clock # "expired") /\ UNCHANGED <<source, clock>>
Done == /\ phase = "decided" /\ UNCHANGED vars
Next == Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ source \in {"scan", "direct"} /\ clock \in {"invalid", "recent", "expired"}
          /\ phase \in {"observed", "decided"} /\ blocked \in BOOLEAN
InvalidBlocks == phase = "decided" /\ clock = "invalid" => blocked
RecentBlocks == phase = "decided" /\ clock = "recent" => blocked
ExpiredAllows == phase = "decided" /\ clock = "expired" => ~blocked
=============================================================================
