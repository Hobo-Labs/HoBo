-------------------------- MODULE ClaimWindow --------------------------
EXTENDS Naturals
CONSTANTS WindowEnd, WorkDuration
ASSUME /\ WindowEnd > 0 /\ WorkDuration > 0 /\ WorkDuration <= WindowEnd
VARIABLES phase, now, held
vars == <<phase, now, held>>
Init == /\ phase = "ready" /\ now = 0 /\ held = FALSE
BeginClaim == /\ phase = "ready" /\ now + WorkDuration <= WindowEnd
              /\ phase' = "claiming" /\ UNCHANGED <<now, held>>
Wait == /\ phase \in {"claiming", "committed"} /\ now <= WindowEnd
        /\ now' = now + 1 /\ UNCHANGED <<phase, held>>
Commit == /\ phase = "claiming" /\ phase' = "committed" /\ held' = TRUE
          /\ UNCHANGED now
Allow == /\ phase = "committed" /\ now + WorkDuration <= WindowEnd
         /\ phase' = "allowed" /\ UNCHANGED <<now, held>>
Deny == /\ phase = "committed" /\ now + WorkDuration > WindowEnd
        /\ phase' = "denied" /\ UNCHANGED <<now, held>>
Done == /\ phase \in {"allowed", "denied"} /\ UNCHANGED vars
Next == BeginClaim \/ Wait \/ Commit \/ Allow \/ Deny \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "claiming", "committed", "allowed", "denied"}
          /\ now \in 0..(WindowEnd + 1) /\ held \in BOOLEAN
AllowedWithinWindow == phase = "allowed" => now + WorkDuration <= WindowEnd
CommittedHoldRetained == phase \in {"committed", "allowed", "denied"} => held
=============================================================================
