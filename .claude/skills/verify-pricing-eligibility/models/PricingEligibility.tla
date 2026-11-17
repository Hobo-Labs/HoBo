---------------------- MODULE PricingEligibility ----------------------
EXTENDS Naturals
VARIABLES version, completeness, allowPartial, metadataLost, phase, eligibility
vars == <<version,completeness,allowPartial,metadataLost,phase,eligibility>>
Init == /\ version \in {"old","v9"} /\ completeness \in {"complete","partial","unknown"}
        /\ allowPartial \in BOOLEAN /\ metadataLost \in BOOLEAN
        /\ phase = "received" /\ eligibility = "none"
Quote == /\ phase = "received"
         /\ LET valid == IF version = "v9" THEN completeness \in {"complete","partial"} ELSE TRUE
                allowed == completeness = "complete" \/ allowPartial
            IN /\ phase' = IF valid /\ allowed THEN "quoted" ELSE "rejected"
               /\ eligibility' = IF ~(valid /\ allowed) THEN "none"
                    ELSE IF metadataLost THEN "missing"
                    ELSE IF version = "v9" /\ completeness = "partial" THEN "ineligible" ELSE "eligible"
         /\ UNCHANGED <<version,completeness,allowPartial,metadataLost>>
Dispatch == /\ phase = "quoted"
            /\ phase' = IF (IF version = "v9" THEN eligibility = "eligible" ELSE eligibility # "ineligible")
                         THEN "selected" ELSE "not-selected"
            /\ UNCHANGED <<version,completeness,allowPartial,metadataLost,eligibility>>
Done == /\ phase \in {"rejected","selected","not-selected"} /\ UNCHANGED vars
Next == Quote \/ Dispatch \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v9"} /\ completeness \in {"complete","partial","unknown"}
          /\ allowPartial \in BOOLEAN /\ metadataLost \in BOOLEAN
          /\ phase \in {"received","quoted","rejected","selected","not-selected"}
          /\ eligibility \in {"none","missing","eligible","ineligible"}
CurrentSelectionSafe == version = "v9" /\ phase = "selected" => completeness = "complete" /\ eligibility = "eligible"
AllSelectionSafe == phase = "selected" => completeness = "complete" /\ eligibility = "eligible"
=============================================================================
