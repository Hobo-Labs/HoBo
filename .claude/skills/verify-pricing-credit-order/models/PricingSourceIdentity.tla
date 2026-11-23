---------------------- MODULE PricingSourceIdentity ----------------------
EXTENDS Naturals
CONSTANTS CheckOwned, CheckUnique, CheckPresent, CheckAccount
VARIABLES kind, owned, unique, present, accountScoped, phase, accepted, consumed
vars == <<kind, owned, unique, present, accountScoped, phase, accepted, consumed>>
Admitted == /\ (~CheckOwned \/ owned) /\ (~CheckUnique \/ unique)
            /\ (~CheckPresent \/ present) /\ (~CheckAccount \/ accountScoped)
Init == /\ kind \in {"allowance", "credit", "commitment"}
        /\ owned \in BOOLEAN /\ unique \in BOOLEAN /\ present \in BOOLEAN /\ accountScoped \in BOOLEAN
        /\ phase = "received" /\ accepted = FALSE /\ consumed = 0
Validate == /\ phase = "received"
            /\ accepted' = Admitted
            /\ phase' = IF Admitted THEN "accepted" ELSE "rejected"
            /\ UNCHANGED <<kind, owned, unique, present, accountScoped, consumed>>
Apply == /\ phase = "accepted" /\ phase' = "applied"
         /\ consumed' = IF unique THEN 1 ELSE 2
         /\ UNCHANGED <<kind, owned, unique, present, accountScoped, accepted>>
Done == /\ phase \in {"rejected", "applied"} /\ UNCHANGED vars
Next == Validate \/ Apply \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ kind \in {"allowance", "credit", "commitment"}
          /\ owned \in BOOLEAN /\ unique \in BOOLEAN /\ present \in BOOLEAN /\ accountScoped \in BOOLEAN /\ accepted \in BOOLEAN
          /\ phase \in {"received", "rejected", "accepted", "applied"} /\ consumed \in 0..2
SourceSafe == accepted => owned /\ unique /\ present /\ accountScoped
NoDouble == phase = "applied" => consumed <= 1
=============================================================================
