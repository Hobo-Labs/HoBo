---------------------- MODULE PricingMeterBinding ----------------------
EXTENDS Naturals
CONSTANTS CheckProduct, CheckMeterKnown, CheckMeterUnique, CheckChargeUnique
VARIABLES version, productMatches, meterKnown, meterUnique, chargeUnique, phase
vars == <<version,productMatches,meterKnown,meterUnique,chargeUnique,phase>>
Bound == /\ (~CheckProduct \/ productMatches) /\ (~CheckMeterKnown \/ meterKnown)
         /\ (~CheckMeterUnique \/ meterUnique) /\ (~CheckChargeUnique \/ chargeUnique)
Init == /\ version \in {"old","v6"}
        /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
        /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF version = "v6" /\ ~Bound THEN "rejected" ELSE "rated"
            /\ UNCHANGED <<version,productMatches,meterKnown,meterUnique,chargeUnique>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v6"} /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
          /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase \in {"received","rejected","rated"}
CurrentBindingSafe == version = "v6" /\ phase = "rated" => productMatches /\ meterKnown /\ meterUnique /\ chargeUnique
BindingSafe == CurrentBindingSafe
AllBindingSafe == phase = "rated" => productMatches /\ meterKnown /\ meterUnique /\ chargeUnique
=============================================================================
