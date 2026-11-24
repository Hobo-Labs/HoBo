----------------------- MODULE UncertainCapacity -----------------------
EXTENDS Naturals
VARIABLES phase, claimed, settled, confirmed, held, releases
vars == <<phase, claimed, settled, confirmed, held, releases>>
Init == /\ phase = "reserved" /\ claimed = FALSE /\ settled = FALSE
        /\ confirmed = FALSE /\ held = TRUE /\ releases = 0
Register == /\ phase = "reserved" /\ phase' = "registered"
            /\ UNCHANGED <<claimed, settled, confirmed, held, releases>>
Claim == /\ phase = "registered" /\ phase' = "running" /\ claimed' = TRUE
         /\ UNCHANGED <<settled, confirmed, held, releases>>
LoseContact == /\ phase \in {"reserved", "registered", "running"}
               /\ phase' = "uncertain"
               /\ UNCHANGED <<claimed, settled, confirmed, held, releases>>
ConfirmTeardown == /\ phase = "uncertain" /\ ~confirmed /\ confirmed' = TRUE
                   /\ UNCHANGED <<phase, claimed, settled, held, releases>>
Settle == /\ phase = "uncertain" /\ claimed /\ ~settled /\ settled' = TRUE
          /\ UNCHANGED <<phase, claimed, confirmed, held, releases>>
Release == /\ phase = "uncertain" /\ confirmed /\ (~claimed \/ settled)
           /\ phase' = "released" /\ held' = FALSE /\ releases' = releases + 1
           /\ UNCHANGED <<claimed, settled, confirmed>>
Done == /\ phase = "released" /\ UNCHANGED vars
Next == Register \/ Claim \/ LoseContact \/ ConfirmTeardown \/ Settle \/ Release \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"reserved", "registered", "running", "uncertain", "released"}
          /\ claimed \in BOOLEAN /\ settled \in BOOLEAN /\ confirmed \in BOOLEAN
          /\ held \in BOOLEAN /\ releases \in Nat
UncertainCapacityHeld == phase = "uncertain" => held
ReleasedRequiresTeardown == phase = "released" => confirmed
ClaimedReleaseSettled == (phase = "released" /\ claimed) => settled
ReleasedAtMostOnce == releases <= 1
=============================================================================
