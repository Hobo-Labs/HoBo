-------------------------- MODULE AwsHttpIngress --------------------------
EXTENDS Naturals, FiniteSets, TLC

\* Abstract request units stand for bytes and chunks. Parser allocation, HTTP
\* transport, timers, cancellation and application behavior are assumptions.
CONSTANTS Requests, Limit, MaxUnits
VARIABLES state, slots, units, dispatched, timedOut, response
vars == <<state, slots, units, dispatched, timedOut, response>>
Init ==
  /\ state = [r \in Requests |-> "idle"] /\ slots = {}
  /\ units = [r \in Requests |-> 0] /\ dispatched = [r \in Requests |-> FALSE]
  /\ timedOut = [r \in Requests |-> FALSE] /\ response = [r \in Requests |-> "none"]
Start(r) ==
  /\ state[r] = "idle" /\ Cardinality(slots) < Limit
  /\ state' = [state EXCEPT ![r] = "reading"] /\ slots' = slots \cup {r}
  /\ UNCHANGED <<units, dispatched, timedOut, response>>
Read(r) ==
  /\ state[r] = "reading" /\ units[r] <= MaxUnits
  /\ units' = [units EXCEPT ![r] = @ + 1]
  /\ UNCHANGED <<state, slots, dispatched, timedOut, response>>
Reject(r) ==
  /\ state[r] = "reading" /\ units[r] > MaxUnits
  /\ state' = [state EXCEPT ![r] = "canceling"]
  /\ response' = [response EXCEPT ![r] = "too-large"]
  /\ UNCHANGED <<slots, units, dispatched, timedOut>>
Dispatch(r) ==
  /\ state[r] = "reading" /\ ~timedOut[r] /\ units[r] <= MaxUnits
  /\ state' = [state EXCEPT ![r] = "handling"]
  /\ dispatched' = [dispatched EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<slots, units, timedOut, response>>
TimeoutRead(r) ==
  /\ state[r] = "reading"
  /\ state' = [state EXCEPT ![r] = "canceling"]
  /\ timedOut' = [timedOut EXCEPT ![r] = TRUE]
  /\ response' = [response EXCEPT ![r] = "timeout"]
  /\ UNCHANGED <<slots, units, dispatched>>
TimeoutHandler(r) ==
  /\ state[r] = "handling"
  /\ state' = [state EXCEPT ![r] = "timedout-handler"]
  /\ timedOut' = [timedOut EXCEPT ![r] = TRUE]
  /\ response' = [response EXCEPT ![r] = "timeout"]
  /\ UNCHANGED <<slots, units, dispatched>>
Finish(r) ==
  /\ state[r] \in {"handling", "timedout-handler", "canceling"}
  /\ state' = [state EXCEPT ![r] = "done"] /\ slots' = slots \ {r}
  /\ response' = [response EXCEPT ![r] = IF @ = "none" THEN "success" ELSE @]
  /\ UNCHANGED <<units, dispatched, timedOut>>
Next == \E r \in Requests: Start(r) \/ Read(r) \/ Reject(r) \/ Dispatch(r) \/ TimeoutRead(r) \/ TimeoutHandler(r) \/ Finish(r)
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in [Requests -> {"idle", "reading", "handling", "timedout-handler", "canceling", "done"}]
          /\ slots \subseteq Requests /\ units \in [Requests -> 0..(MaxUnits + 1)]
          /\ dispatched \in [Requests -> BOOLEAN] /\ timedOut \in [Requests -> BOOLEAN]
          /\ response \in [Requests -> {"none", "too-large", "timeout", "success"}]
CapacityBound == Cardinality(slots) <= Limit
OutstandingRetainsSlot == \A r \in Requests: state[r] \in {"reading", "handling", "timedout-handler", "canceling"} => r \in slots
TimeoutBeforeDispatch == \A r \in Requests: timedOut[r] /\ ~dispatched[r] => state[r] \notin {"reading", "handling"}
NoOversizedDispatch == \A r \in Requests: dispatched[r] => units[r] <= MaxUnits
NeverTimedOut == \A r \in Requests: ~timedOut[r]
NeverDispatched == \A r \in Requests: ~dispatched[r]
=============================================================================
