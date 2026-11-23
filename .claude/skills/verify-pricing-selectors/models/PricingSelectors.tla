------------------------- MODULE PricingSelectors -------------------------
EXTENDS Naturals
CONSTANTS RequireAllPriced, OwnPrice
VARIABLES first, priceA, priceB, qtyA, qtyB, pricedA, pricedB, phase, billed
vars == <<first, priceA, priceB, qtyA, qtyB, pricedA, pricedB, phase, billed>>
Init == /\ first \in {"a", "b"}
        /\ priceA \in 1..2 /\ priceB \in 1..2 /\ qtyA \in 1..2 /\ qtyB \in 1..2
        /\ pricedA \in BOOLEAN /\ pricedB \in BOOLEAN
        /\ phase = "received" /\ billed = 0
Select == /\ phase = "received"
          /\ phase' = IF IF RequireAllPriced THEN pricedA /\ pricedB
                         ELSE IF first = "a" THEN pricedA ELSE pricedB
                       THEN "selected" ELSE "rejected"
          /\ UNCHANGED <<first,priceA,priceB,qtyA,qtyB,pricedA,pricedB,billed>>
Rate == /\ phase = "selected"
        /\ billed' = IF OwnPrice THEN priceA * qtyA + priceB * qtyB
                     ELSE (IF first = "a" THEN priceA ELSE priceB) * (qtyA + qtyB)
        /\ phase' = "rated"
        /\ UNCHANGED <<first,priceA,priceB,qtyA,qtyB,pricedA,pricedB>>
Done == /\ phase \in {"rejected","rated"} /\ UNCHANGED vars
Next == Select \/ Rate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ first \in {"a","b"}
          /\ priceA \in 1..2 /\ priceB \in 1..2 /\ qtyA \in 1..2 /\ qtyB \in 1..2
          /\ pricedA \in BOOLEAN /\ pricedB \in BOOLEAN
          /\ phase \in {"received","selected","rejected","rated"} /\ billed \in 0..8
AllPriced == phase = "rated" => pricedA /\ pricedB
Matches == phase = "rated" => billed = priceA * qtyA + priceB * qtyB
ChartSubset == qtyA = 1 /\ qtyB = 1
=============================================================================
