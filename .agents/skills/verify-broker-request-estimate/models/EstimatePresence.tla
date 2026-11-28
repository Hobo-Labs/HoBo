------------------------- MODULE EstimatePresence -------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES origin, input, phase
vars == <<origin, input, phase>>
Init == /\ origin \in {"document", "local", "registry"}
        /\ input \in {"missing", "zero", "positive", "invalid", "conflict"}
        /\ (origin # "document" => input = "missing")
        /\ phase = "received"
Allowed == input \in {"zero", "positive"} \/
           (input = "missing" /\ (origin = "local" \/ ~Current)) \/
           (input = "conflict" /\ ~Current)
Admit == /\ phase = "received" /\ Allowed
         /\ phase' = "admitted" /\ UNCHANGED <<origin, input>>
Reject == /\ phase = "received" /\ ~Allowed
          /\ phase' = "rejected" /\ UNCHANGED <<origin, input>>
Done == /\ phase \in {"admitted", "rejected"} /\ UNCHANGED vars
Next == Admit \/ Reject \/ Done
Spec == Init /\ [][Next]_vars
UnknownRejected == (input = "missing" /\ origin # "local") => phase # "admitted"
ConflictsRejected == input = "conflict" => phase # "admitted"
ExplicitZeroAccepted == input = "zero" => phase # "rejected"
InvalidRejected == input = "invalid" => phase # "admitted"
TypeOK == /\ origin \in {"document", "local", "registry"}
          /\ input \in {"missing", "zero", "positive", "invalid", "conflict"}
          /\ phase \in {"received", "admitted", "rejected"}
=============================================================================
