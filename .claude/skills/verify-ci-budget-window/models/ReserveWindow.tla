------------------------- MODULE ReserveWindow -------------------------
EXTENDS Naturals
CONSTANTS WindowEnd, WorkDuration
ASSUME /\ WindowEnd > 0 /\ WorkDuration > 0 /\ WorkDuration <= WindowEnd
VARIABLES phase, now, held, fallback
vars == <<phase, now, held, fallback>>
Init == /\ phase = "ready" /\ now = 0 /\ held = FALSE /\ fallback = TRUE
Begin == /\ phase = "ready" /\ now + WorkDuration <= WindowEnd
         /\ phase' = "reserving" /\ UNCHANGED <<now, held, fallback>>
Wait == /\ phase \in {"reserving", "committed"} /\ now <= WindowEnd
        /\ now' = now + 1 /\ UNCHANGED <<phase, held, fallback>>
Commit == /\ phase = "reserving" /\ phase' = "committed" /\ held' = TRUE
          /\ fallback' = FALSE /\ UNCHANGED now
Accept == /\ phase = "committed" /\ now + WorkDuration <= WindowEnd
          /\ phase' = "accepted" /\ UNCHANGED <<now, held, fallback>>
Refuse == /\ phase = "committed" /\ now + WorkDuration > WindowEnd
          /\ phase' = "refused" /\ UNCHANGED <<now, held, fallback>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Begin \/ Wait \/ Commit \/ Accept \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "reserving", "committed", "accepted", "refused"}
          /\ now \in 0..(WindowEnd + 1) /\ held \in BOOLEAN /\ fallback \in BOOLEAN
AcceptedWithinWindow == phase = "accepted" => now + WorkDuration <= WindowEnd
CommittedHoldRetained == phase \in {"committed", "accepted", "refused"} => held
NoFallbackWithHold == held => ~fallback
=============================================================================
