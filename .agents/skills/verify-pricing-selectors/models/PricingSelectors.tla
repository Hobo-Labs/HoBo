------------------------- MODULE PricingSelectors -------------------------
EXTENDS Naturals
CONSTANTS RequireAllPriced, OwnPrice
VARIABLES version, first, priceA, priceB, qtyA, qtyB, pricedA, pricedB, phase, billed
vars == <<version, first, priceA, priceB, qtyA, qtyB, pricedA, pricedB, phase, billed>>
Init == /\ version \in {"old", "v6"} /\ first \in {"a", "b"}
        /\ priceA \in 1..2 /\ priceB \in 1..2 /\ qtyA \in 1..2 /\ qtyB \in 1..2
        /\ pricedA \in BOOLEAN /\ pricedB \in BOOLEAN
        /\ phase = "received" /\ billed = 0
Select == /\ phase = "received"
          /\ phase' = IF version = "v6" THEN
                         IF IF RequireAllPriced THEN pricedA /\ pricedB
                            ELSE IF first = "a" THEN pricedA ELSE pricedB
                         THEN "selected" ELSE "rejected"
                       ELSE IF (IF first = "a" THEN pricedA ELSE pricedB)
                            THEN "selected" ELSE "rejected"
          /\ UNCHANGED <<version,first,priceA,priceB,qtyA,qtyB,pricedA,pricedB,billed>>
Rate == /\ phase = "selected"
        /\ billed' = IF version = "v6" /\ OwnPrice THEN priceA * qtyA + priceB * qtyB
                     ELSE (IF first = "a" THEN priceA ELSE priceB) * (qtyA + qtyB)
        /\ phase' = "rated"
        /\ UNCHANGED <<version,first,priceA,priceB,qtyA,qtyB,pricedA,pricedB>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Select \/ Rate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in {"old","v6"} /\ first \in {"a","b"}
          /\ priceA \in 1..2 /\ priceB \in 1..2 /\ qtyA \in 1..2 /\ qtyB \in 1..2
          /\ pricedA \in BOOLEAN /\ pricedB \in BOOLEAN
          /\ phase \in {"received","selected","rejected","rated"} /\ billed \in 0..8
CurrentAllPriced == version = "v6" /\ phase = "rated" => pricedA /\ pricedB
AllPriced == CurrentAllPriced
CurrentMatches == version = "v6" /\ phase = "rated" => billed = priceA * qtyA + priceB * qtyB
Matches == CurrentMatches
ChartSubset == qtyA = 1 /\ qtyB = 1
AllMatches == phase = "rated" => pricedA /\ pricedB /\ billed = priceA * qtyA + priceB * qtyB
=============================================================================
