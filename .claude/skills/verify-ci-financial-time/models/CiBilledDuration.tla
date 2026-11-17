-------------------------- MODULE CiBilledDuration --------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES start, finish, billed, phase
vars == <<start, finish, billed, phase>>
Init == /\ start \in 0..5 /\ finish \in start..5 /\ billed = 0 /\ phase = "pending"
Approx == ((finish \div 2 - start \div 2) + 1) \div 2
Exact == IF finish > start + Approx * 4 THEN Approx + 1 ELSE Approx
Bill == /\ phase = "pending" /\ billed' = IF Current THEN Exact ELSE Approx
        /\ phase' = "billed" /\ UNCHANGED <<start, finish>>
Done == /\ phase = "billed" /\ UNCHANGED vars
Next == Bill \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ start \in 0..5 /\ finish \in start..5 /\ billed \in 0..2 /\ phase \in {"pending", "billed"}
DurationCovered == phase = "billed" => billed * 4 >= finish - start
MinimumWholeMinutes == phase = "billed" /\ billed > 0 => (billed - 1) * 4 < finish - start
=============================================================================
