---------------------- MODULE PricingSourceIdentity ----------------------
EXTENDS Naturals
VARIABLES version, kind, owned, unique, present, accountScoped, phase, accepted, consumed
vars == <<version, kind, owned, unique, present, accountScoped, phase, accepted, consumed>>
Init == /\ version \in {"old", "v4", "v5"} /\ kind \in {"allowance", "credit", "commitment"}
        /\ owned \in BOOLEAN /\ unique \in BOOLEAN /\ present \in BOOLEAN /\ accountScoped \in BOOLEAN
        /\ phase = "received" /\ accepted = FALSE /\ consumed = 0
Validate == /\ phase = "received"
            /\ accepted' = IF version # "old" THEN owned /\ unique /\ present /\ accountScoped ELSE TRUE
            /\ phase' = IF version # "old" /\ ~(owned /\ unique /\ present /\ accountScoped) THEN "rejected" ELSE "accepted"
            /\ UNCHANGED <<version, kind, owned, unique, present, accountScoped, consumed>>
Apply == /\ phase = "accepted" /\ phase' = "applied"
         /\ consumed' = IF unique THEN 1 ELSE 2
         /\ UNCHANGED <<version, kind, owned, unique, present, accountScoped, accepted>>
Done == /\ phase \in {"rejected", "applied"} /\ UNCHANGED vars
Next == Validate \/ Apply \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old", "v4", "v5"} /\ kind \in {"allowance", "credit", "commitment"}
          /\ owned \in BOOLEAN /\ unique \in BOOLEAN /\ present \in BOOLEAN /\ accountScoped \in BOOLEAN /\ accepted \in BOOLEAN
          /\ phase \in {"received", "rejected", "accepted", "applied"} /\ consumed \in 0..2
CurrentSourceSafe == version # "old" /\ accepted => owned /\ unique /\ present /\ accountScoped
CurrentNoDouble == version # "old" /\ phase = "applied" => consumed <= 1
AllSourceSafe == accepted => owned /\ unique /\ present /\ accountScoped
=============================================================================
