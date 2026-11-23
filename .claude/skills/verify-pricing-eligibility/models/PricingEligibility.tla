---------------------- MODULE PricingEligibility ----------------------
EXTENDS Naturals
CONSTANTS CheckCompleteness, PartialIneligible, RequireEligible
VARIABLES completeness, allowPartial, metadataLost, phase, eligibility
vars == <<completeness,allowPartial,metadataLost,phase,eligibility>>
Init == /\ completeness \in {"complete","partial","unknown"}
        /\ allowPartial \in BOOLEAN /\ metadataLost \in BOOLEAN
        /\ phase = "received" /\ eligibility = "none"
Quote == /\ phase = "received"
         /\ LET valid == ~CheckCompleteness \/ completeness \in {"complete","partial"}
                allowed == completeness = "complete" \/ allowPartial
            IN /\ phase' = IF valid /\ allowed THEN "quoted" ELSE "rejected"
               /\ eligibility' = IF ~(valid /\ allowed) THEN "none"
                    ELSE IF metadataLost THEN "missing"
                    ELSE IF PartialIneligible /\ completeness = "partial" THEN "ineligible" ELSE "eligible"
         /\ UNCHANGED <<completeness,allowPartial,metadataLost>>
Dispatch == /\ phase = "quoted"
            /\ phase' = IF (IF RequireEligible THEN eligibility = "eligible" ELSE eligibility # "ineligible")
                         THEN "selected" ELSE "not-selected"
            /\ UNCHANGED <<completeness,allowPartial,metadataLost,eligibility>>
Done == /\ phase \in {"rejected","selected","not-selected"} /\ UNCHANGED vars
Next == Quote \/ Dispatch \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ completeness \in {"complete","partial","unknown"}
          /\ allowPartial \in BOOLEAN /\ metadataLost \in BOOLEAN
          /\ phase \in {"received","quoted","rejected","selected","not-selected"}
          /\ eligibility \in {"none","missing","eligible","ineligible"}
SelectionSafe == phase = "selected" => completeness = "complete" /\ eligibility = "eligible"
=============================================================================
