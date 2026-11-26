------------------------- MODULE AwsKvRuntime -------------------------
EXTENDS Naturals, FiniteSets, TLC

\* One bounded store instance; a call can remain in flight after its caller times out.
\* The host's authorization decisions and transport behavior are assumptions.
CONSTANTS Calls, Limit
VARIABLES state, slots, permit, op, result, admitted, verified
vars == <<state, slots, permit, op, result, admitted, verified>>

Init ==
  /\ state = [c \in Calls |-> "idle"] /\ slots = {}
  /\ permit = TRUE /\ op \in [Calls -> {"read", "write"}]
  /\ result = [c \in Calls |-> "none"]
  /\ admitted = [c \in Calls |-> FALSE]
  /\ verified = [c \in Calls |-> FALSE]

Start(c) ==
  /\ state[c] = "idle" /\ permit /\ Cardinality(slots) < Limit
  /\ state' = [state EXCEPT ![c] = "running"]
  /\ slots' = slots \cup {c} /\ admitted' = [admitted EXCEPT ![c] = permit]
  /\ UNCHANGED <<permit, op, result, verified>>

Timeout(c) ==
  /\ state[c] = "running"
  /\ state' = [state EXCEPT ![c] = "timedout"]
  /\ result' = [result EXCEPT ![c] = IF op[c] = "write" THEN "unknown" ELSE "unavailable"]
  /\ UNCHANGED <<slots, permit, op, admitted, verified>>

Finish(c) ==
  /\ state[c] = "running"
  /\ state' = [state EXCEPT ![c] = IF permit THEN "ready" ELSE "done"] /\ slots' = slots \ {c}
  /\ result' = [result EXCEPT ![c] = IF permit THEN "none" ELSE IF op[c] = "write" THEN "unknown" ELSE "unavailable"]
  /\ verified' = [verified EXCEPT ![c] = permit]
  /\ UNCHANGED <<permit, op, admitted>>

Deliver(c) ==
  /\ state[c] = "ready"
  /\ state' = [state EXCEPT ![c] = "done"]
  /\ result' = [result EXCEPT ![c] = IF permit /\ verified[c] THEN "success" ELSE IF op[c] = "write" THEN "unknown" ELSE "unavailable"]
  /\ verified' = [verified EXCEPT ![c] = permit /\ verified[c]]
  /\ UNCHANGED <<slots, permit, op, admitted>>

LateFinish(c) ==
  /\ state[c] = "timedout"
  /\ state' = [state EXCEPT ![c] = "done"] /\ slots' = slots \ {c}
  /\ UNCHANGED <<permit, op, result, admitted, verified>>

ChangePermit == /\ permit' = ~permit /\ UNCHANGED <<state, slots, op, result, admitted, verified>>
Next == (\E c \in Calls: Start(c) \/ Timeout(c) \/ Finish(c) \/ Deliver(c) \/ LateFinish(c)) \/ ChangePermit
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in [Calls -> {"idle", "running", "timedout", "ready", "done"}]
          /\ slots \subseteq Calls /\ permit \in BOOLEAN /\ op \in [Calls -> {"read", "write"}]
          /\ result \in [Calls -> {"none", "success", "unknown", "unavailable"}]
          /\ admitted \in [Calls -> BOOLEAN] /\ verified \in [Calls -> BOOLEAN]
CapacityBound == Cardinality(slots) <= Limit
OutstandingRetainsSlot == \A c \in Calls: state[c] \in {"running", "timedout"} => c \in slots
StartedAuthorized == \A c \in Calls: state[c] # "idle" => admitted[c]
SuccessReverified == \A c \in Calls: result[c] = "success" => verified[c]
NeverReadyAfterRevocation == \A c \in Calls: ~(state[c] = "ready" /\ ~permit)
TimeoutIsUncertain == \A c \in Calls: state[c] = "timedout" /\ op[c] = "write" => result[c] = "unknown"
=============================================================================
