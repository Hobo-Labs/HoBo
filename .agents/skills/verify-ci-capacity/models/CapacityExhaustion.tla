----------------------- MODULE CapacityExhaustion -----------------------
EXTENDS Naturals
CONSTANT Limit
ASSUME Limit > 0
VARIABLES sequence, accepted, previous
vars == <<sequence, accepted, previous>>
Init == /\ sequence = Limit - 1 /\ accepted = FALSE /\ previous = Limit - 1
Attempt == /\ previous' = sequence
           /\ IF sequence < Limit
              THEN /\ sequence' = sequence + 1 /\ accepted' = TRUE
              ELSE /\ UNCHANGED sequence /\ accepted' = FALSE
Next == Attempt
Spec == Init /\ [][Next]_vars
TypeOK == /\ sequence \in Nat /\ previous \in Nat /\ accepted \in BOOLEAN
NoOverflow == sequence <= Limit
AcceptedOnlyBeforeLimit == accepted => previous < Limit
=============================================================================
