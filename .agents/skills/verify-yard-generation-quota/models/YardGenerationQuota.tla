--------------------- MODULE YardGenerationQuota ----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS CheckConcurrent, CheckTenant, CheckBaseline, CheckReady
Requests == 1..3
Tenants == {"a", "b"}
Tenant(i) == IF i \in {1,2} THEN "a" ELSE "b"
Baseline(t) == IF t = "a" THEN 1 ELSE 0
MaxConcurrent == 1
MaxYards == 2
VARIABLES claim, verified
vars == <<claim, verified>>
Init == /\ claim = [i \in Requests |-> "none"]
        /\ verified = [i \in Requests |-> FALSE]
Active == Cardinality({i \in Requests : claim[i] = "pending"})
Claimed(t) == Cardinality({i \in Requests : Tenant(i) = t /\ claim[i] # "none"})
Total(t) == Baseline(t) + Claimed(t)
Reserve(i) == /\ claim[i] = "none"
              /\ IF CheckConcurrent THEN Active < MaxConcurrent ELSE TRUE
              /\ IF CheckTenant THEN (IF CheckBaseline THEN Baseline(Tenant(i)) ELSE 0) + Claimed(Tenant(i)) < MaxYards ELSE TRUE
              /\ claim' = [claim EXCEPT ![i] = "pending"]
              /\ UNCHANGED verified
Ready(i, evidence) == /\ claim[i] = "pending"
                      /\ evidence \in BOOLEAN
                      /\ IF CheckReady THEN evidence ELSE TRUE
                      /\ claim' = [claim EXCEPT ![i] = "ready"]
                      /\ verified' = [verified EXCEPT ![i] = evidence]
Stutter == UNCHANGED vars
Next == (\E i \in Requests : Reserve(i)) \/ (\E i \in Requests, evidence \in BOOLEAN : Ready(i, evidence)) \/ Stutter
Spec == Init /\ [][Next]_vars
TypeOK == /\ claim \in [Requests -> {"none", "pending", "ready"}]
          /\ verified \in [Requests -> BOOLEAN]
ConcurrentBound == Active <= MaxConcurrent
TenantBound == \A t \in Tenants : Total(t) <= MaxYards
ReadyVerified == \A i \in Requests : claim[i] = "ready" => verified[i]
=============================================================================
