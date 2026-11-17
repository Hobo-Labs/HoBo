---------------------------- MODULE NumericWire ----------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES exact, projected, phase
vars == <<exact, projected, phase>>
Init == /\ exact \in {"below", "crossed"} /\ projected \in {"below", "crossed", "underflow"} /\ phase = "pending"
Agrees == projected = exact
Accept == /\ phase = "pending" /\ (IF Current THEN Agrees ELSE TRUE)
          /\ phase' = "accepted" /\ UNCHANGED <<exact, projected>>
Refuse == /\ phase = "pending" /\ Current /\ ~Agrees
          /\ phase' = "refused" /\ UNCHANGED <<exact, projected>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Accept \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ exact \in {"below", "crossed"} /\ projected \in {"below", "crossed", "underflow"} /\ phase \in {"pending", "accepted", "refused"}
SafeWire == phase = "accepted" => Agrees
AccurateAccepted == Agrees => phase # "refused"
=============================================================================
