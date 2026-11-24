-------------------------- MODULE LedgerSequence --------------------------
EXTENDS Naturals
CONSTANT MaxSeq
VARIABLES seq, initialSeq, pending, initialPending, advanced, operation, phase, mutations
vars == <<seq, initialSeq, pending, initialPending, advanced, operation, phase, mutations>>
Init == /\ seq \in 0..MaxSeq /\ initialSeq = seq
        /\ pending \in 0..2 /\ initialPending = pending
        /\ advanced = FALSE /\ operation \in {"single", "expire", "replay"}
        /\ phase = "ready" /\ mutations = 0
Single == /\ phase = "ready" /\ operation = "single"
          /\ IF seq < MaxSeq
                THEN /\ seq' = seq + 1 /\ mutations' = mutations + 1 /\ phase' = "done"
                ELSE /\ phase' = "rejected" /\ UNCHANGED <<seq, mutations>>
          /\ UNCHANGED <<initialSeq, pending, initialPending, advanced, operation>>
Replay == /\ phase = "ready" /\ operation = "replay" /\ phase' = "done"
          /\ UNCHANGED <<seq, initialSeq, pending, initialPending, advanced, operation, mutations>>
PreflightExpiry == /\ phase = "ready" /\ operation = "expire"
                   /\ phase' = IF pending + 1 <= MaxSeq - seq THEN "advance" ELSE "rejected"
                   /\ UNCHANGED <<seq, initialSeq, pending, initialPending, advanced, operation, mutations>>
AdvanceTime == /\ phase = "advance"
               /\ IF seq < MaxSeq
                     THEN /\ seq' = seq + 1 /\ mutations' = mutations + 1 /\ advanced' = TRUE /\ phase' = "releasing"
                     ELSE /\ phase' = "rejected" /\ UNCHANGED <<seq, mutations, advanced>>
               /\ UNCHANGED <<initialSeq, pending, initialPending, operation>>
Release == /\ phase = "releasing" /\ pending > 0
           /\ IF seq < MaxSeq
                 THEN /\ seq' = seq + 1 /\ mutations' = mutations + 1 /\ pending' = pending - 1
                 ELSE /\ phase' = "rejected" /\ UNCHANGED <<seq, mutations, pending>>
           /\ IF seq < MaxSeq THEN phase' = "releasing" ELSE TRUE
           /\ UNCHANGED <<initialSeq, initialPending, advanced, operation>>
Finish == /\ phase = "releasing" /\ pending = 0 /\ phase' = "done"
          /\ UNCHANGED <<seq, initialSeq, pending, initialPending, advanced, operation, mutations>>
Done == /\ phase \in {"done", "rejected"} /\ UNCHANGED vars
Next == Single \/ Replay \/ PreflightExpiry \/ AdvanceTime \/ Release \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ seq \in 0..MaxSeq /\ initialSeq \in 0..MaxSeq
          /\ pending \in 0..2 /\ initialPending \in 0..2 /\ advanced \in BOOLEAN
          /\ operation \in {"single", "expire", "replay"}
          /\ phase \in {"ready", "advance", "releasing", "done", "rejected"}
          /\ mutations \in 0..MaxSeq
SequenceCountsMutations == seq = initialSeq + mutations
RejectedUnchanged == phase = "rejected" => seq = initialSeq /\ pending = initialPending /\ ~advanced
ReplayUnchanged == phase = "done" /\ operation = "replay" => seq = initialSeq /\ pending = initialPending /\ ~advanced
ExpiryComplete == phase = "done" /\ operation = "expire" => pending = 0 /\ advanced
=============================================================================
