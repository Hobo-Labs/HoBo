---------------------- MODULE PricingMeterBinding ----------------------
EXTENDS Naturals
CONSTANTS CheckProduct, CheckMeterKnown, CheckMeterUnique, CheckChargeUnique
VARIABLES productMatches, meterKnown, meterUnique, chargeUnique, phase
vars == <<productMatches,meterKnown,meterUnique,chargeUnique,phase>>
Bound == /\ (~CheckProduct \/ productMatches) /\ (~CheckMeterKnown \/ meterKnown)
         /\ (~CheckMeterUnique \/ meterUnique) /\ (~CheckChargeUnique \/ chargeUnique)
Init == /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
        /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase = "received"
Validate == /\ phase = "received"
            /\ phase' = IF Bound THEN "rated" ELSE "rejected"
            /\ UNCHANGED <<productMatches,meterKnown,meterUnique,chargeUnique>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Validate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ productMatches \in BOOLEAN /\ meterKnown \in BOOLEAN
          /\ meterUnique \in BOOLEAN /\ chargeUnique \in BOOLEAN /\ phase \in {"received","rejected","rated"}
BindingSafe == phase = "rated" => productMatches /\ meterKnown /\ meterUnique /\ chargeUnique
=============================================================================
