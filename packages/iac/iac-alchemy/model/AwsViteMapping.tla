----------------------------- MODULE AwsViteMapping -----------------------------
EXTENDS Naturals, FiniteSets

Expected == {"build", "bucket", "delivery"}
Resources == Expected \cup {"unexpected"}
Phases == {"new", "mapped", "planned", "started"}
VARIABLES phase, inventory, liveMode, sourceValid, mappingValid, planValid, startValid
vars == <<phase, inventory, liveMode, sourceValid, mappingValid, planValid, startValid>>

Init ==
  /\ phase = "new"
  /\ inventory \in SUBSET Resources
  /\ liveMode \in BOOLEAN
  /\ sourceValid = TRUE
  /\ mappingValid = FALSE
  /\ planValid = FALSE
  /\ startValid = FALSE

InventoryOK == inventory = Expected /\ liveMode
SourceOK == sourceValid

Map ==
  /\ phase = "new" /\ InventoryOK /\ SourceOK
  /\ phase' = "mapped"
  /\ mappingValid' = (inventory = Expected /\ liveMode /\ sourceValid)
  /\ UNCHANGED <<inventory, liveMode, sourceValid, planValid, startValid>>

Plan ==
  /\ phase = "mapped" /\ SourceOK
  /\ phase' = "planned"
  /\ planValid' = sourceValid
  /\ UNCHANGED <<inventory, liveMode, sourceValid, mappingValid, startValid>>

Start ==
  /\ phase = "planned" /\ SourceOK
  /\ phase' = "started"
  /\ startValid' = sourceValid
  /\ UNCHANGED <<inventory, liveMode, sourceValid, mappingValid, planValid>>

Revoke ==
  /\ sourceValid
  /\ sourceValid' = FALSE
  /\ UNCHANGED <<phase, inventory, liveMode, mappingValid, planValid, startValid>>

Next == Map \/ Plan \/ Start \/ Revoke
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in Phases /\ inventory \in SUBSET Resources
          /\ liveMode \in BOOLEAN /\ sourceValid \in BOOLEAN
          /\ mappingValid \in BOOLEAN /\ planValid \in BOOLEAN /\ startValid \in BOOLEAN
ExactLiveMapping == phase \in {"mapped", "planned", "started"} => mappingValid
SourceVerifiedAtPlan == phase \in {"planned", "started"} => planValid
SourceVerifiedAtStart == phase = "started" => startValid
NeverStarted == phase # "started"
=============================================================================
