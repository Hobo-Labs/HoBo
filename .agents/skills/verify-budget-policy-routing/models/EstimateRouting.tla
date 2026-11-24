--------------------------- MODULE EstimateRouting ---------------------------
EXTENDS Naturals
VARIABLES cheapCap, fundedCap, estimate, phase, choice, held, replayed
vars == <<cheapCap, fundedCap, estimate, phase, choice, held, replayed>>
Max(a,b) == IF a >= b THEN a ELSE b
Price(p) == IF p = "cheap" THEN 0 ELSE 1
Cap(p) == IF p = "cheap" THEN cheapCap ELSE fundedCap
Affordable(p, e) == Max(Price(p), e) <= Cap(p)
Pick(e) == IF Affordable("cheap", e) THEN "cheap"
           ELSE IF Affordable("funded", e) THEN "funded" ELSE "none"
Init == /\ cheapCap \in 0..2 /\ fundedCap \in 0..2 /\ estimate \in 0..2
        /\ phase = "ready" /\ choice = "none" /\ held = 0 /\ replayed = "none"
Select == /\ phase = "ready" /\ choice' = Pick(estimate)
          /\ phase' = IF Pick(estimate) = "none" THEN "denied" ELSE "selected"
          /\ UNCHANGED <<cheapCap, fundedCap, estimate, held, replayed>>
Reserve == /\ phase = "selected"
           /\ IF Affordable(choice, estimate)
                 THEN /\ phase' = "reserved" /\ held' = Max(Price(choice), estimate)
                 ELSE /\ phase' = "denied" /\ held' = held
           /\ UNCHANGED <<cheapCap, fundedCap, estimate, choice, replayed>>
Replay == /\ phase = "reserved" /\ phase' = "replayed" /\ replayed' = Pick(estimate)
          /\ UNCHANGED <<cheapCap, fundedCap, estimate, choice, held>>
Done == /\ phase \in {"denied", "replayed"} /\ UNCHANGED vars
Next == Select \/ Reserve \/ Replay \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ cheapCap \in 0..2 /\ fundedCap \in 0..2 /\ estimate \in 0..2 /\ held \in 0..2
          /\ choice \in {"none", "cheap", "funded"} /\ replayed \in {"none", "cheap", "funded"}
          /\ phase \in {"ready", "selected", "reserved", "replayed", "denied"}
SelectedAffordable == phase = "selected" => Affordable(choice, estimate)
NoAffordableProviderMissed == phase = "denied" => ~Affordable("cheap", estimate) /\ ~Affordable("funded", estimate)
FullHold == phase \in {"reserved", "replayed"} => held = Max(Price(choice), estimate) /\ held <= Cap(choice)
ReplayStable == phase = "replayed" => replayed = choice
=============================================================================
