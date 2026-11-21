------------------------- MODULE PricingCreditOrder -------------------------
EXTENDS Naturals
VARIABLES version, basis, doneEn, doneSv, paidEn, promoEn, paidSv, promoSv, effectiveEn, effectiveSv
vars == <<version, basis, doneEn, doneSv, paidEn, promoEn, paidSv, promoSv, effectiveEn, effectiveSv>>
First(locale) == IF version # "v1" THEN "paid" ELSE IF locale = "en" THEN "promo" ELSE "paid"
Init == /\ version \in {"v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"} /\ basis \in {1, 9}
        /\ doneEn = FALSE /\ doneSv = FALSE /\ paidEn = 1 /\ promoEn = 1 /\ paidSv = 1 /\ promoSv = 1
        /\ effectiveEn = 0 /\ effectiveSv = 0
RateEn == /\ ~doneEn /\ doneEn' = TRUE
          /\ paidEn' = IF First("en") = "paid" THEN 0 ELSE 1
          /\ promoEn' = IF First("en") = "promo" THEN 0 ELSE 1
          /\ effectiveEn' = IF First("en") = "paid" THEN basis ELSE 0
          /\ UNCHANGED <<version, basis, doneSv, paidSv, promoSv, effectiveSv>>
RateSv == /\ ~doneSv /\ doneSv' = TRUE
          /\ paidSv' = IF First("sv") = "paid" THEN 0 ELSE 1
          /\ promoSv' = IF First("sv") = "promo" THEN 0 ELSE 1
          /\ effectiveSv' = IF First("sv") = "paid" THEN basis ELSE 0
          /\ UNCHANGED <<version, basis, doneEn, paidEn, promoEn, effectiveEn>>
Done == /\ doneEn /\ doneSv /\ UNCHANGED vars
Next == RateEn \/ RateSv \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"} /\ basis \in {1, 9} /\ doneEn \in BOOLEAN /\ doneSv \in BOOLEAN
          /\ paidEn \in 0..1 /\ promoEn \in 0..1 /\ paidSv \in 0..1 /\ promoSv \in 0..1
          /\ effectiveEn \in {0, basis} /\ effectiveSv \in {0, basis}
CreditConservation == /\ (doneEn => paidEn + promoEn = 1) /\ (doneSv => paidSv + promoSv = 1)
BasisMatchesConsumption == /\ (doneEn => effectiveEn = IF paidEn = 0 THEN basis ELSE 0)
                           /\ (doneSv => effectiveSv = IF paidSv = 0 THEN basis ELSE 0)
NewQuoteStable == version # "v1" /\ doneEn /\ doneSv => /\ paidEn = paidSv /\ promoEn = promoSv /\ effectiveEn = effectiveSv
AllQuotesStable == doneEn /\ doneSv => /\ paidEn = paidSv /\ promoEn = promoSv /\ effectiveEn = effectiveSv
=============================================================================
