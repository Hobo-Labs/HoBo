-------------------------- MODULE SharedMapping --------------------------
EXTENDS Naturals, TLC

VARIABLES external, owned, registered, reported, shared, shareProof
vars == <<external, owned, registered, reported, shared, shareProof>>

Init ==
  /\ external \in BOOLEAN /\ owned = FALSE
  /\ registered = {} /\ reported = {}
  /\ shared = FALSE /\ shareProof = FALSE

Allocate ==
  /\ ~external /\ ~owned
  /\ owned' = TRUE /\ registered' = {"resource"} /\ reported' = {"resource"}
  /\ UNCHANGED <<external, shared, shareProof>>

Share(declared, exact, writes) ==
  /\ owned /\ ~shared
  /\ declared /\ exact /\ writes = 0
  /\ shared' = TRUE
  /\ shareProof' = (declared /\ exact /\ writes = 0)
  /\ registered' = IF writes = 0 THEN registered ELSE registered \cup {"hidden"}
  /\ UNCHANGED <<external, owned, reported>>

Next == Allocate \/ (\E declared, exact \in BOOLEAN: \E writes \in 0..1:
  Share(declared, exact, writes))
Spec == Init /\ [][Next]_vars

TypeOK == /\ external \in BOOLEAN /\ owned \in BOOLEAN /\ shared \in BOOLEAN
          /\ shareProof \in BOOLEAN
          /\ registered \subseteq {"resource", "hidden"}
          /\ reported \subseteq {"resource", "hidden"}
NoExternalAlias == shared => owned
ShareExactAndDeclared == shared => shareProof
InventoryComplete == registered = reported
NeverShared == ~shared
=============================================================================
