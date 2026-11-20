------------------------- MODULE BrokerFence -------------------------
EXTENDS Naturals
\* Cryptography and durable storage are abstracted as correct predicates.
VARIABLES phase, claimed, candidate, stored, attempts
vars == <<phase, claimed, candidate, stored, attempts>>
Proofs == [receiver : BOOLEAN, finance : BOOLEAN, binding : BOOLEAN]
Empty == [receiver |-> FALSE, finance |-> FALSE, binding |-> FALSE]
Valid(p) == p.receiver /\ p.finance /\ p.binding
Init == /\ phase = "new" /\ claimed = FALSE /\ candidate = Empty
        /\ stored = Empty /\ attempts = 0
Reserve == /\ phase = "new" /\ phase' = "held"
           /\ UNCHANGED <<claimed, candidate, stored, attempts>>
Claim == /\ phase \in {"held", "uncertain"} /\ ~claimed
         /\ claimed' = TRUE /\ UNCHANGED <<phase, candidate, stored, attempts>>
Uncertain == /\ phase = "held" /\ phase' = "uncertain"
             /\ UNCHANGED <<claimed, candidate, stored, attempts>>
Offer == \E p \in Proofs:
         /\ phase \in {"held", "uncertain"} /\ attempts < 3
         /\ candidate' = IF Valid(p) THEN p ELSE Empty
         /\ attempts' = attempts + 1
         /\ UNCHANGED <<phase, claimed, stored>>
Settle == /\ phase \in {"held", "uncertain"} /\ claimed /\ Valid(candidate)
           /\ phase' = "settled" /\ stored' = candidate
           /\ UNCHANGED <<claimed, candidate, attempts>>
Release == /\ phase \in {"held", "uncertain"} /\ ~claimed
            /\ phase' = "released" /\ UNCHANGED <<claimed, candidate, stored, attempts>>
Fenced == phase = "uncertain" /\ claimed /\ attempts = 3 /\ ~Valid(candidate)
Done == \/ /\ phase \in {"settled", "released"} /\ UNCHANGED vars
        \/ /\ Fenced /\ UNCHANGED vars
Next == Reserve \/ Claim \/ Uncertain \/ Offer \/ Settle \/ Release \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"new", "held", "uncertain", "settled", "released"}
          /\ claimed \in BOOLEAN /\ candidate \in Proofs /\ stored \in Proofs
          /\ attempts \in 0..3
SettledRequiresClaimAndProofs == phase = "settled" => claimed /\ Valid(stored)
ClaimedFundsRemainHeld == claimed /\ phase # "settled" => phase \in {"held", "uncertain"}
NoUnsettledReceipt == phase # "settled" => stored = Empty
=============================================================================
