---------------------- MODULE PricingTierCoverage ----------------------
EXTENDS Naturals
CONSTANTS CheckAdjacency
VARIABLES version, firstEnd, secondStart, sample, phase, covered
vars == <<version,firstEnd,secondStart,sample,phase,covered>>
Init == /\ version \in {"old","v8"} /\ firstEnd \in 1..3 /\ secondStart \in 1..3
        /\ sample \in 0..3 /\ phase = "received" /\ covered = 0
Validate == /\ phase = "received"
            /\ phase' = IF version = "v8" /\ CheckAdjacency /\ firstEnd # secondStart THEN "rejected" ELSE "validated"
            /\ UNCHANGED <<version,firstEnd,secondStart,sample,covered>>
Rate == /\ phase = "validated" /\ phase' = "rated"
        /\ covered' = (IF sample < firstEnd THEN 1 ELSE 0) + (IF sample >= secondStart THEN 1 ELSE 0)
        /\ UNCHANGED <<version,firstEnd,secondStart,sample>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Validate \/ Rate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v8"} /\ firstEnd \in 1..3 /\ secondStart \in 1..3
          /\ sample \in 0..3 /\ phase \in {"received","validated","rejected","rated"} /\ covered \in 0..2
CurrentExactlyOnce == version = "v8" /\ phase = "rated" => covered = 1
ExactlyOnce == CurrentExactlyOnce
AllExactlyOnce == phase = "rated" => covered = 1
=============================================================================
