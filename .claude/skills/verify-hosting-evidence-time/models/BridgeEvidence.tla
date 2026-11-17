-------------------------- MODULE BridgeEvidence --------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES observed, clock, phase
vars == <<observed, clock, phase>>
Init == /\ observed \in 0..3 /\ clock \in 0..1 /\ phase = "received"
Allowed == IF Current THEN observed <= clock * 2 ELSE (observed \div 2) <= clock
Accept == /\ phase = "received" /\ Allowed /\ phase' = "accepted" /\ UNCHANGED <<observed, clock>>
Reject == /\ phase = "received" /\ ~Allowed /\ phase' = "rejected" /\ UNCHANGED <<observed, clock>>
Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Accept \/ Reject \/ Done
Spec == Init /\ [][Next]_vars
NoFuture == phase = "accepted" => observed <= clock * 2
CurrentAccepted == observed <= clock * 2 => phase # "rejected"
TypeOK == /\ observed \in 0..3 /\ clock \in 0..1 /\ phase \in {"received", "accepted", "rejected"}
=============================================================================
