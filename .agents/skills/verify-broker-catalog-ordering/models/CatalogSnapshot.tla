----------------------------- MODULE CatalogSnapshot ------------------------
EXTENDS Naturals
CONSTANT CheckSnapshot
VARIABLES priceStable, regionStable, phase
vars == <<priceStable, regionStable, phase>>
Init == /\ priceStable \in BOOLEAN /\ regionStable \in BOOLEAN /\ phase = "compared"
Allowed == IF CheckSnapshot THEN priceStable /\ regionStable ELSE TRUE
Select == /\ phase = "compared" /\ Allowed /\ phase' = "selected"
          /\ UNCHANGED <<priceStable, regionStable>>
Refuse == /\ phase = "compared" /\ ~Allowed /\ phase' = "refused"
          /\ UNCHANGED <<priceStable, regionStable>>
Done == /\ phase \in {"selected", "refused"} /\ UNCHANGED vars
Next == Select \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ priceStable \in BOOLEAN /\ regionStable \in BOOLEAN /\ phase \in {"compared", "selected", "refused"}
StableSelection == phase = "selected" => priceStable /\ regionStable
=============================================================================
