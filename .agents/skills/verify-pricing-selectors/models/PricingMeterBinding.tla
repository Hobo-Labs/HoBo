---------------------- MODULE PricingMeterBinding ----------------------
EXTENDS Naturals
VARIABLES version, productMatches, meterKnown, meterUnique, chargeUnique, phase
vars == <<version,productMatches,meterKnown,meterUnique,chargeUnique,phase>>
Init == /\ version \in {"old","v6"}
        /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
        /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF version = "v6" /\ ~(productMatches /\ meterKnown /\ meterUnique /\ chargeUnique)
                         THEN "rejected" ELSE "rated"
            /\ UNCHANGED <<version,productMatches,meterKnown,meterUnique,chargeUnique>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v6"} /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
          /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase \in {"received","rejected","rated"}
CurrentBindingSafe == version = "v6" /\ phase = "rated" => productMatches /\ meterKnown /\ meterUnique /\ chargeUnique
AllBindingSafe == phase = "rated" => productMatches /\ meterKnown /\ meterUnique /\ chargeUnique
=============================================================================
