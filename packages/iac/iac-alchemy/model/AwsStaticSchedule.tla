--------------------------- MODULE AwsStaticSchedule ---------------------------
EXTENDS FiniteSets

Expected == {"queue", "schedule"}
VARIABLES target, configured, cadence, payload, covered, mode, policy,
          phase, inventory, admission
vars == <<target, configured, cadence, payload, covered, mode, policy,
          phase, inventory, admission>>

Init ==
  /\ target \in {"queue", "other"} /\ configured \in BOOLEAN
  /\ cadence \in BOOLEAN /\ payload \in BOOLEAN /\ covered \in SUBSET Expected
  /\ mode \in {"budget", "unpriced"} /\ policy \in BOOLEAN
  /\ phase = "new" /\ inventory = {} /\ admission = "none"

Valid == target = "queue" /\ configured /\ cadence /\ payload
Map ==
  /\ phase = "new" /\ Valid
  /\ phase' = "mapped" /\ inventory' = Expected
  /\ UNCHANGED <<target, configured, cadence, payload, covered, mode, policy, admission>>
RejectMapping ==
  /\ phase = "new" /\ ~Valid
  /\ phase' = "rejected"
  /\ UNCHANGED <<target, configured, cadence, payload, covered, mode, policy, inventory, admission>>
AdmitBudget ==
  /\ phase = "mapped" /\ mode = "budget" /\ covered = inventory
  /\ phase' = "admitted" /\ admission' = "budget"
  /\ UNCHANGED <<target, configured, cadence, payload, covered, mode, policy, inventory>>
AdmitUnpriced ==
  /\ phase = "mapped" /\ mode = "unpriced" /\ policy
  /\ phase' = "admitted" /\ admission' = "unpriced"
  /\ UNCHANGED <<target, configured, cadence, payload, covered, mode, policy, inventory>>
RejectAdmission ==
  /\ phase = "mapped" /\ ((mode = "budget" /\ covered # inventory) \/ (mode = "unpriced" /\ ~policy))
  /\ phase' = "rejected"
  /\ UNCHANGED <<target, configured, cadence, payload, covered, mode, policy, inventory, admission>>
Next == Map \/ RejectMapping \/ AdmitBudget \/ AdmitUnpriced \/ RejectAdmission
Spec == Init /\ [][Next]_vars
TypeOK == /\ target \in {"queue", "other"} /\ configured \in BOOLEAN
          /\ cadence \in BOOLEAN /\ payload \in BOOLEAN /\ covered \subseteq Expected
          /\ mode \in {"budget", "unpriced"} /\ policy \in BOOLEAN
          /\ phase \in {"new", "mapped", "admitted", "rejected"}
          /\ inventory \subseteq Expected /\ admission \in {"none", "budget", "unpriced"}
ValidMapping == inventory = Expected => Valid
BudgetCoversInventory == admission = "budget" => covered = Expected
UnpricedRequiresPolicy == admission = "unpriced" => policy
NeverAdmitted == phase # "admitted"
=============================================================================
