--------------------- MODULE ReservationConsumption ---------------------
EXTENDS Naturals
VARIABLES units, claimed, kind, unique, phase, restored
vars == <<units, claimed, kind, unique, phase, restored>>
Cap == IF kind = "slot" THEN 1 ELSE units
Valid == claimed <= Cap /\ (kind # "credit" \/ unique)
Init == /\ units \in 1..2 /\ claimed \in 0..2
        /\ kind \in {"free", "rate", "credit", "slot"} /\ unique \in BOOLEAN
        /\ phase = "loaded" /\ restored = 0
Validate == /\ phase = "loaded" /\ phase' = IF Valid THEN "pending" ELSE "rejected"
            /\ UNCHANGED <<units, claimed, kind, unique, restored>>
Release == /\ phase = "pending" /\ phase' = "released" /\ restored' = restored + claimed
           /\ UNCHANGED <<units, claimed, kind, unique>>
Done == /\ phase \in {"released", "rejected"} /\ UNCHANGED vars
Next == Validate \/ Release \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ units \in 1..2 /\ claimed \in 0..2
          /\ kind \in {"free", "rate", "credit", "slot"} /\ unique \in BOOLEAN
          /\ phase \in {"loaded", "pending", "released", "rejected"} /\ restored \in 0..2
NoOverRestore == phase = "released" => restored <= Cap
NoDuplicateCreditRestore == phase = "released" /\ kind = "credit" => unique
RejectedUnchanged == phase = "rejected" => restored = 0
SingleRestore == phase = "released" => restored = claimed
=============================================================================
