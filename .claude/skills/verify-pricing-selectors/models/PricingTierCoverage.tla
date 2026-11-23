---------------------- MODULE PricingTierCoverage ----------------------
EXTENDS Naturals
CONSTANTS CheckAdjacency
VARIABLES firstEnd, secondStart, sample, phase, covered
vars == <<firstEnd,secondStart,sample,phase,covered>>
Init == /\ firstEnd \in 1..3 /\ secondStart \in 1..3
        /\ sample \in 0..3 /\ phase = "received" /\ covered = 0
Validate == /\ phase = "received"
            /\ phase' = IF CheckAdjacency /\ firstEnd # secondStart THEN "rejected" ELSE "validated"
            /\ UNCHANGED <<firstEnd,secondStart,sample,covered>>
Rate == /\ phase = "validated" /\ phase' = "rated"
        /\ covered' = (IF sample < firstEnd THEN 1 ELSE 0) + (IF sample >= secondStart THEN 1 ELSE 0)
        /\ UNCHANGED <<firstEnd,secondStart,sample>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Validate \/ Rate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ firstEnd \in 1..3 /\ secondStart \in 1..3
          /\ sample \in 0..3 /\ phase \in {"received","validated","rejected","rated"} /\ covered \in 0..2
ExactlyOnce == phase = "rated" => covered = 1
=============================================================================
