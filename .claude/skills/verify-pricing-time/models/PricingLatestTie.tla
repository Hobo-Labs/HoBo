------------------------- MODULE PricingLatestTie -------------------------
EXTENDS Naturals
VARIABLES version, timeA, timeB, valueA, valueB, phase, orderAB, orderBA
vars == <<version,timeA,timeB,valueA,valueB,phase,orderAB,orderBA>>
Init == /\ version \in {"old","v7"} /\ timeA \in 0..1 /\ timeB \in 0..1
        /\ valueA \in 0..1 /\ valueB \in 0..1 /\ phase = "received"
        /\ orderAB = 0 /\ orderBA = 0
Choose == /\ phase = "received"
          /\ IF version = "v7" /\ timeA = timeB /\ valueA # valueB
             THEN /\ phase' = "rejected" /\ UNCHANGED <<orderAB,orderBA>>
             ELSE /\ phase' = "rated"
                  /\ orderAB' = IF timeA >= timeB THEN valueA ELSE valueB
                  /\ orderBA' = IF timeB >= timeA THEN valueB ELSE valueA
          /\ UNCHANGED <<version,timeA,timeB,valueA,valueB>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Choose \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v7"} /\ timeA \in 0..1 /\ timeB \in 0..1
          /\ valueA \in 0..1 /\ valueB \in 0..1 /\ phase \in {"received","rated","rejected"}
          /\ orderAB \in 0..1 /\ orderBA \in 0..1
CurrentStable == version = "v7" /\ phase = "rated" => orderAB = orderBA
CurrentNoConflict == version = "v7" /\ phase = "rated" => timeA # timeB \/ valueA = valueB
AllStable == phase = "rated" => orderAB = orderBA
=============================================================================
