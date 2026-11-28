------------------------- MODULE FinancialHistory -------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES old, next, changed, evidence, sameText, kind, phase
vars == <<old, next, changed, evidence, sameText, kind, phase>>
Init == /\ old \in 0..3 /\ next \in 0..3
        /\ changed \in BOOLEAN /\ evidence \in BOOLEAN /\ sameText \in BOOLEAN
        /\ sameText => old = next
        /\ kind \in {"spend", "entitlement"} /\ phase = "received"
Allowed == IF Current
           THEN next >= old /\ (next > old \/ ~changed \/ (kind = "spend" /\ evidence))
           ELSE IF kind = "spend"
                THEN (next \div 2) >= (old \div 2) /\ ~(sameText /\ changed /\ ~evidence)
                ELSE (next \div 2) >= (old \div 2) /\ ~((next \div 2) = (old \div 2) /\ changed)
Accept == /\ phase = "received" /\ Allowed /\ phase' = "accepted"
          /\ UNCHANGED <<old, next, changed, evidence, sameText, kind>>
Reject == /\ phase = "received" /\ ~Allowed /\ phase' = "rejected"
          /\ UNCHANGED <<old, next, changed, evidence, sameText, kind>>
Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Accept \/ Reject \/ Done
Spec == Init /\ [][Next]_vars
NoOlder == phase = "accepted" => next >= old
EqualChangeNeedsEvidence == (phase = "accepted" /\ changed /\ next = old) => (kind = "spend" /\ evidence)
NewerAccepted == next > old => phase # "rejected"
TypeOK == /\ old \in 0..3 /\ next \in 0..3 /\ changed \in BOOLEAN /\ evidence \in BOOLEAN
          /\ sameText \in BOOLEAN /\ kind \in {"spend", "entitlement"}
          /\ phase \in {"received", "accepted", "rejected"}
=============================================================================
