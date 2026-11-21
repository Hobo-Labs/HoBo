-------------------------- MODULE DeliveryLease --------------------------
EXTENDS Naturals
CONSTANT MaxAttempts
VARIABLES phase, owner, fence, expired, generation, trackedOwner, trackedFence,
          trackedGeneration, badAck
vars == <<phase, owner, fence, expired, generation, trackedOwner, trackedFence,
          trackedGeneration, badAck>>

Init == /\ phase = "pending" /\ owner = "none" /\ fence = 0 /\ expired = FALSE
        /\ generation = 0 /\ trackedOwner = "none" /\ trackedFence = 0
        /\ trackedGeneration = 0 /\ badAck = FALSE

Claim == \E id \in {"a", "b"}, token \in {1, 2}:
         /\ phase = "pending" /\ generation = 0
         /\ phase' = "leased" /\ owner' = id /\ fence' = token
         /\ generation' = 1
         /\ UNCHANGED <<expired, trackedOwner, trackedFence, trackedGeneration, badAck>>

Remember == /\ phase = "leased" /\ trackedGeneration = 0
            /\ trackedOwner' = owner /\ trackedFence' = fence
            /\ trackedGeneration' = generation
            /\ UNCHANGED <<phase, owner, fence, expired, generation, badAck>>

Expire == /\ phase = "leased" /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<phase, owner, fence, generation, trackedOwner,
                         trackedFence, trackedGeneration, badAck>>

Reclaim == \E id \in {"a", "b"}, token \in {1, 2}:
           /\ phase = "leased" /\ expired /\ generation < MaxAttempts
           /\ owner' = id /\ fence' = token /\ expired' = FALSE
           /\ generation' = generation + 1
           /\ UNCHANGED <<phase, trackedOwner, trackedFence, trackedGeneration, badAck>>

AckTracked == /\ phase = "leased" /\ trackedGeneration > 0
              /\ owner = trackedOwner /\ fence = trackedFence
              /\ generation = trackedGeneration
              /\ phase' = "acked" /\ badAck' = (badAck \/ generation # trackedGeneration)
              /\ UNCHANGED <<owner, fence, expired, generation, trackedOwner,
                             trackedFence, trackedGeneration>>

AckCurrent == /\ phase = "leased" /\ phase' = "acked"
              /\ UNCHANGED <<owner, fence, expired, generation, trackedOwner,
                             trackedFence, trackedGeneration, badAck>>

RefuseStale == /\ phase = "leased" /\ trackedGeneration > 0
               /\ trackedGeneration < generation /\ UNCHANGED vars
Done == /\ phase = "acked" /\ UNCHANGED vars

Next == Claim \/ Remember \/ Expire \/ Reclaim \/ AckTracked \/ AckCurrent \/ RefuseStale \/ Done
Spec == Init /\ [][Next]_vars
NoStaleAcknowledgment == ~badAck
TypeOK == /\ phase \in {"pending", "leased", "acked"}
          /\ owner \in {"none", "a", "b"} /\ fence \in 0..2
          /\ expired \in BOOLEAN /\ generation \in 0..MaxAttempts
          /\ trackedOwner \in {"none", "a", "b"} /\ trackedFence \in 0..2
          /\ trackedGeneration \in 0..generation /\ badAck \in BOOLEAN
=============================================================================
