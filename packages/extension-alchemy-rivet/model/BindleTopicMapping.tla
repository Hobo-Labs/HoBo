------------------------- MODULE BindleTopicMapping -------------------------
EXTENDS Naturals, FiniteSets

Topics == {"orders", "audit"}
VARIABLES appKind, uiOp, phase, graphValid, scopeValid, graphApproved, cursor, confirmed,
          physicalCount, started, scopeAtStart
vars == <<appKind, uiOp, phase, graphValid, scopeValid, graphApproved, cursor, confirmed,
          physicalCount, started, scopeAtStart>>
Order == <<"audit", "orders">>

Init ==
  /\ appKind \in {"web", "ui"} /\ uiOp \in {"none", "render", "drive"}
  /\ (appKind = "web" => uiOp = "none")
  /\ phase = "new" /\ graphValid \in BOOLEAN /\ scopeValid = TRUE
  /\ graphApproved = FALSE /\ cursor = 1 /\ confirmed = {}
  /\ physicalCount = 0 /\ started = FALSE /\ scopeAtStart = FALSE

Map ==
  /\ phase = "new" /\ graphValid /\ scopeValid
  /\ (appKind # "ui" \/ uiOp = "none")
  /\ phase' = "mapped" /\ graphApproved' = graphValid /\ physicalCount' = 1
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, cursor, confirmed, started, scopeAtStart>>

Begin ==
  /\ phase = "mapped" /\ phase' = "provisioning"
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, graphApproved, cursor, confirmed,
                 physicalCount, started, scopeAtStart>>

Commit ==
  /\ phase = "provisioning" /\ cursor \in 1..2
  /\ confirmed' = confirmed \cup {Order[cursor]} /\ cursor' = cursor + 1
  /\ phase' = IF cursor = 2 THEN "ready" ELSE "provisioning"
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, graphApproved, physicalCount, started, scopeAtStart>>

Unknown ==
  /\ phase = "provisioning" /\ phase' = "uncertain"
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, graphApproved, cursor, confirmed,
                 physicalCount, started, scopeAtStart>>

Retry ==
  /\ phase = "uncertain" /\ phase' = "provisioning"
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, graphApproved, cursor, confirmed,
                 physicalCount, started, scopeAtStart>>

Revoke ==
  /\ scopeValid /\ scopeValid' = FALSE
  /\ UNCHANGED <<appKind, uiOp, phase, graphValid, graphApproved, cursor, confirmed,
                 physicalCount, started, scopeAtStart>>

Start ==
  /\ phase = "ready" /\ scopeValid
  /\ phase' = "started" /\ started' = TRUE /\ scopeAtStart' = scopeValid
  /\ UNCHANGED <<appKind, uiOp, graphValid, scopeValid, graphApproved, cursor, confirmed, physicalCount>>

Next == Map \/ Begin \/ Commit \/ Unknown \/ Retry \/ Revoke \/ Start
Spec == Init /\ [][Next]_vars
TypeOK == /\ appKind \in {"web", "ui"} /\ uiOp \in {"none", "render", "drive"}
          /\ phase \in {"new", "mapped", "provisioning", "uncertain", "ready", "started"}
          /\ graphValid \in BOOLEAN /\ scopeValid \in BOOLEAN /\ graphApproved \in BOOLEAN
          /\ cursor \in 1..3 /\ confirmed \subseteq Topics /\ physicalCount \in 0..2
          /\ started \in BOOLEAN /\ scopeAtStart \in BOOLEAN
UiOperationsNotMapped == (phase # "new" /\ appKind = "ui") => uiOp = "none"
NeverUiStarted == ~(started /\ appKind = "ui")
OnlyMatchingGraphMapped == phase # "new" => graphApproved
OnePhysicalResource == phase # "new" => physicalCount = 1
OnlyPreparedApplicationStarts == started => (confirmed = Topics /\ scopeAtStart /\ graphApproved)
NeverStarted == ~started
=============================================================================
