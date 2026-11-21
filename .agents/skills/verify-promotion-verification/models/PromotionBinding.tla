---------------------- MODULE PromotionBinding ----------------------
EXTENDS Naturals
\* Two different requests race for one idempotency key. The journal's CAS,
\* metadata preservation, and collision-free fingerprints are assumptions.
CONSTANT Clients
Identity(c) == IF c = 1 THEN "promote" ELSE "up"
VARIABLES journal, phase
vars == <<journal, phase>>
Init == /\ journal = "empty" /\ phase = [c \in Clients |-> "new"]
Read == \E c \in Clients:
        /\ phase[c] = "new" /\ phase' = [phase EXCEPT ![c] = "append"]
        /\ UNCHANGED journal
Append == \E c \in Clients:
          /\ phase[c] = "append"
          /\ journal' = IF journal = "empty" THEN Identity(c) ELSE journal
          /\ phase' = [phase EXCEPT ![c] = "check"]
Check == \E c \in Clients:
         /\ phase[c] = "check"
         /\ phase' = [phase EXCEPT ![c] = IF journal = Identity(c) THEN "accepted" ELSE "rejected"]
         /\ UNCHANGED journal
Advance == \E c \in Clients:
           /\ phase[c] = "accepted" /\ phase' = [phase EXCEPT ![c] = "advanced"]
           /\ UNCHANGED journal
Done == UNCHANGED vars
Next == Read \/ Append \/ Check \/ Advance \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ journal \in {"empty"} \cup {Identity(c) : c \in Clients}
          /\ phase \in [Clients -> {"new", "append", "check", "accepted", "rejected", "advanced"}]
NoFalseAcknowledgement == \A c \in Clients : phase[c] \in {"accepted", "advanced"} => journal = Identity(c)
NoFalseRejection == \A c \in Clients : phase[c] = "rejected" => journal # Identity(c)
=============================================================================
