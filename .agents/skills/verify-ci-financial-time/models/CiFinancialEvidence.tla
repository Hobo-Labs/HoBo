------------------------ MODULE CiFinancialEvidence ------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES observed, previous, now, changed, valid, sameSpelling, phase
vars == <<observed, previous, now, changed, valid, sameSpelling, phase>>
Init == /\ observed \in 0..2 /\ previous \in 0..2 /\ now \in 0..2
        /\ changed \in BOOLEAN /\ valid \in BOOLEAN /\ sameSpelling \in BOOLEAN
        /\ (sameSpelling => observed = previous) /\ phase = "pending"
ExactAllowed == /\ valid /\ observed <= now /\ observed >= previous
                /\ (observed # previous \/ ~changed)
LegacyAllowed == /\ observed \div 2 <= now \div 2 /\ observed \div 2 >= previous \div 2
                 /\ (~sameSpelling \/ ~changed)
Allowed == IF Current THEN ExactAllowed ELSE LegacyAllowed
Accept == /\ phase = "pending" /\ Allowed /\ phase' = "accepted"
          /\ UNCHANGED <<observed, previous, now, changed, valid, sameSpelling>>
Refuse == /\ phase = "pending" /\ ~Allowed /\ phase' = "refused"
          /\ UNCHANGED <<observed, previous, now, changed, valid, sameSpelling>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Accept \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ observed \in 0..2 /\ previous \in 0..2 /\ now \in 0..2
          /\ changed \in BOOLEAN /\ valid \in BOOLEAN /\ sameSpelling \in BOOLEAN
          /\ phase \in {"pending", "accepted", "refused"}
ValidTime == phase = "accepted" => valid
\* Invalid text has no meaningful instant; ValidTime separately refuses it.
NoFuture == phase = "accepted" /\ valid => observed <= now
NoBackward == phase = "accepted" /\ valid => observed >= previous
SameInstantRequiresUnchanged == phase = "accepted" /\ valid /\ observed = previous => ~changed
GoodEvidenceAccepted == ExactAllowed => phase # "refused"
=============================================================================
