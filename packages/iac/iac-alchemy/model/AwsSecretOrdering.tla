------------------------ MODULE AwsSecretOrdering ------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Versions, Times
VARIABLES timestamp, result, ordering
vars == <<timestamp, result, ordering>>
Indices == 1..Cardinality(Versions)
Distinct == \A a, b \in Versions : a # b => timestamp[a] # timestamp[b]
Unique(o) == \A a, b \in Indices : a # b => o[a] # o[b]
Sorted(o) == \A a, b \in Indices : a < b => timestamp[o[a]] > timestamp[o[b]]
Orders == {o \in [Indices -> Versions] : Unique(o) /\ Sorted(o)}
Init == /\ timestamp \in [Versions -> Times] /\ result = "pending"
        /\ ordering = [i \in Indices |-> CHOOSE v \in Versions: TRUE]
List == /\ result = "pending"
        /\ result' = IF Distinct THEN "success" ELSE "unavailable"
        /\ ordering' = IF Distinct THEN CHOOSE o \in Orders: TRUE ELSE ordering
        /\ UNCHANGED timestamp
Spec == Init /\ [][List]_vars
TypeOK == /\ timestamp \in [Versions -> Times]
          /\ result \in {"pending", "success", "unavailable"}
          /\ ordering \in [Indices -> Versions]
NewestFirst == result = "success" => Unique(ordering) /\ Sorted(ordering)
TieRejected == result = "success" => Distinct
NeverSuccess == result # "success"
NeverUnavailable == result # "unavailable"
=============================================================================
