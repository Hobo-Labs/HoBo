-------------------------- MODULE BrokerResolutionClaim ---------------------
EXTENDS Naturals, FiniteSets
CONSTANTS LockRequests, CheckIssued
Clients == {1, 2}
VARIABLES state, owner, issued, receipts
vars == <<state, owner, issued, receipts>>
Init == /\ state = [c \in Clients |-> "new"] /\ owner = 0 /\ issued = FALSE /\ receipts = 0
CanStart == /\ (IF LockRequests THEN owner = 0 ELSE TRUE)
            /\ (IF CheckIssued THEN ~issued ELSE TRUE)
Start(c) == /\ state[c] = "new" /\ CanStart
            /\ state' = [state EXCEPT ![c] = "preparing"]
            /\ owner' = IF LockRequests THEN c ELSE owner
            /\ UNCHANGED <<issued, receipts>>
Reject(c) == /\ state[c] = "new" /\ ~CanStart
             /\ state' = [state EXCEPT ![c] = "rejected"]
             /\ UNCHANGED <<owner, issued, receipts>>
Issue(c) == /\ state[c] = "preparing" /\ receipts < 2
            /\ state' = [state EXCEPT ![c] = "resolved"]
            /\ owner' = IF owner = c THEN 0 ELSE owner
            /\ issued' = TRUE /\ receipts' = receipts + 1
Abort(c) == /\ state[c] = "preparing"
            /\ state' = [state EXCEPT ![c] = "rejected"]
            /\ owner' = IF owner = c THEN 0 ELSE owner
            /\ UNCHANGED <<issued, receipts>>
Done == /\ \A c \in Clients: state[c] \in {"resolved", "rejected"}
        /\ UNCHANGED vars
Next == (\E c \in Clients: Start(c) \/ Reject(c) \/ Issue(c) \/ Abort(c)) \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in [Clients -> {"new", "preparing", "resolved", "rejected"}]
          /\ owner \in {0, 1, 2} /\ issued \in BOOLEAN /\ receipts \in 0..2
AtMostOneReceipt == receipts <= 1
IssuedMatchesCount == issued <=> receipts > 0
=============================================================================
