------------------------- MODULE PricingLatestTie -------------------------
EXTENDS Naturals
CONSTANTS RejectConflict
VARIABLES timeA, timeB, valueA, valueB, phase, orderAB, orderBA
vars == <<timeA,timeB,valueA,valueB,phase,orderAB,orderBA>>
Init == /\ timeA \in 0..1 /\ timeB \in 0..1
        /\ valueA \in 0..1 /\ valueB \in 0..1 /\ phase = "received"
        /\ orderAB = 0 /\ orderBA = 0
Choose == /\ phase = "received"
          /\ IF RejectConflict /\ timeA = timeB /\ valueA # valueB
             THEN /\ phase' = "rejected" /\ UNCHANGED <<orderAB,orderBA>>
             ELSE /\ phase' = "rated"
                  /\ orderAB' = IF timeA >= timeB THEN valueA ELSE valueB
                  /\ orderBA' = IF timeB >= timeA THEN valueB ELSE valueA
          /\ UNCHANGED <<timeA,timeB,valueA,valueB>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Choose \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ timeA \in 0..1 /\ timeB \in 0..1
          /\ valueA \in 0..1 /\ valueB \in 0..1 /\ phase \in {"received","rated","rejected"}
          /\ orderAB \in 0..1 /\ orderBA \in 0..1
Stable == phase = "rated" => orderAB = orderBA
NoConflict == phase = "rated" => timeA # timeB \/ valueA = valueB
=============================================================================
