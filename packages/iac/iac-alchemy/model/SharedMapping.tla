-------------------------- MODULE SharedMapping --------------------------
EXTENDS Naturals, TLC

\* Graph validation is a trusted synchronous mapper decision; this abstraction
\* does not prove the provider-specific validator or implementation.
VARIABLES external, owned, registered, reported, shared, shareProof, shareMode
vars == <<external, owned, registered, reported, shared, shareProof, shareMode>>

Init ==
  /\ external \in BOOLEAN /\ owned = FALSE
  /\ registered = {} /\ reported = {}
  /\ shared = FALSE /\ shareProof = FALSE /\ shareMode = "none"

Allocate ==
  /\ ~external /\ ~owned
  /\ owned' = TRUE /\ registered' = {"resource"} /\ reported' = {"resource"}
  /\ UNCHANGED <<external, shared, shareProof, shareMode>>

Share(declared, graphValidated, exact, writes) ==
  /\ owned /\ ~shared
  /\ (declared \/ graphValidated) /\ exact /\ writes = 0
  /\ shared' = TRUE
  /\ shareProof' = ((declared \/ graphValidated) /\ exact /\ writes = 0)
  /\ shareMode' = IF declared THEN "dependency" ELSE "graph"
  /\ registered' = IF writes = 0 THEN registered ELSE registered \cup {"hidden"}
  /\ UNCHANGED <<external, owned, reported>>

Next == Allocate \/ (\E declared, graphValidated, exact \in BOOLEAN: \E writes \in 0..1:
  Share(declared, graphValidated, exact, writes))
Spec == Init /\ [][Next]_vars

TypeOK == /\ external \in BOOLEAN /\ owned \in BOOLEAN /\ shared \in BOOLEAN
          /\ shareProof \in BOOLEAN
          /\ shareMode \in {"none", "dependency", "graph"}
          /\ registered \subseteq {"resource", "hidden"}
          /\ reported \subseteq {"resource", "hidden"}
NoExternalAlias == shared => owned
ShareExactAndDeclared == shared => shareProof
InventoryComplete == registered = reported
NeverShared == ~shared
NeverGraphShared == shareMode # "graph"
=============================================================================
