--------------------------- MODULE CiTimeCoverage ---------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES operation, start, duration, expiry, phase
vars == <<operation, start, duration, expiry, phase>>
Init == /\ operation \in {"admit", "settle"} /\ start \in 0..3 /\ duration \in 0..2
        /\ expiry \in 0..7 /\ phase = "pending"
Bound == IF operation = "admit" THEN start + duration * 2 ELSE start
ExactCovered == expiry >= Bound
LegacyCovered == IF operation = "admit" THEN expiry \div 2 >= start \div 2 + duration
                 ELSE expiry \div 2 >= start \div 2
Covered == IF Current THEN ExactCovered ELSE LegacyCovered
Accept == /\ phase = "pending" /\ Covered /\ phase' = "accepted"
          /\ UNCHANGED <<operation, start, duration, expiry>>
Refuse == /\ phase = "pending" /\ ~Covered /\ phase' = "refused"
          /\ UNCHANGED <<operation, start, duration, expiry>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Accept \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ operation \in {"admit", "settle"} /\ start \in 0..3 /\ duration \in 0..2
          /\ expiry \in 0..7 /\ phase \in {"pending", "accepted", "refused"}
CoveredOnly == phase = "accepted" => ExactCovered
CoveredAccepted == ExactCovered => phase # "refused"
=============================================================================
