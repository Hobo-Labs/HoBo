------------------------- MODULE AwsHttpBindings -------------------------
EXTENDS Naturals, FiniteSets, TLC

\* One application with two request slots. The host's grant verification,
\* AWS effects, byte limits and response transport are abstract assumptions.
CONSTANTS Requests, Limit
VARIABLES state, slots, grant, operation, opResult, opVerified, opAdmitted, response, responseVerified
vars == <<state, slots, grant, operation, opResult, opVerified, opAdmitted, response, responseVerified>>
Init ==
  /\ state = [r \in Requests |-> "idle"] /\ slots = {} /\ grant = TRUE
  /\ operation = [r \in Requests |-> "none"]
  /\ opResult = [r \in Requests |-> "none"] /\ opVerified = [r \in Requests |-> FALSE] /\ opAdmitted = [r \in Requests |-> FALSE]
  /\ response = [r \in Requests |-> "none"] /\ responseVerified = [r \in Requests |-> FALSE]
Start(r) ==
  /\ state[r] = "idle" /\ grant /\ Cardinality(slots) < Limit
  /\ state' = [state EXCEPT ![r] = "running"] /\ slots' = slots \cup {r}
  /\ UNCHANGED <<grant, operation, opResult, opVerified, opAdmitted, response, responseVerified>>
BeginOperation(r) ==
  /\ state[r] = "running" /\ grant /\ operation[r] = "none"
  /\ operation' = [operation EXCEPT ![r] = "running"]
  /\ opAdmitted' = [opAdmitted EXCEPT ![r] = state[r] = "running" /\ grant]
  /\ UNCHANGED <<state, slots, grant, opResult, opVerified, response, responseVerified>>
FinishOperation(r) ==
  /\ operation[r] = "running"
  /\ operation' = [operation EXCEPT ![r] = "done"]
  /\ opResult' = [opResult EXCEPT ![r] = IF state[r] = "running" /\ grant THEN "success" ELSE "unknown"]
  /\ opVerified' = [opVerified EXCEPT ![r] = state[r] = "running" /\ grant]
  /\ UNCHANGED <<state, slots, grant, opAdmitted, response, responseVerified>>
Timeout(r) ==
  /\ state[r] = "running"
  /\ state' = [state EXCEPT ![r] = "timedout"] /\ response' = [response EXCEPT ![r] = "unavailable"]
  /\ UNCHANGED <<slots, grant, operation, opResult, opVerified, opAdmitted, responseVerified>>
Deliver(r) ==
  /\ state[r] = "running"
  /\ state' = [state EXCEPT ![r] = "done"] /\ slots' = slots \ {r}
  /\ response' = [response EXCEPT ![r] = IF grant THEN "success" ELSE "unavailable"]
  /\ responseVerified' = [responseVerified EXCEPT ![r] = grant]
  /\ UNCHANGED <<grant, operation, opResult, opVerified, opAdmitted>>
LateFinish(r) ==
  /\ state[r] = "timedout"
  /\ state' = [state EXCEPT ![r] = "done"] /\ slots' = slots \ {r}
  /\ UNCHANGED <<grant, operation, opResult, opVerified, opAdmitted, response, responseVerified>>
ChangeGrant == /\ grant' = ~grant /\ UNCHANGED <<state, slots, operation, opResult, opVerified, opAdmitted, response, responseVerified>>
Next == (\E r \in Requests: Start(r) \/ BeginOperation(r) \/ FinishOperation(r) \/ Timeout(r) \/ Deliver(r) \/ LateFinish(r)) \/ ChangeGrant
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in [Requests -> {"idle", "running", "timedout", "done"}] /\ slots \subseteq Requests /\ grant \in BOOLEAN
          /\ operation \in [Requests -> {"none", "running", "done"}] /\ opResult \in [Requests -> {"none", "success", "unknown"}]
          /\ opVerified \in [Requests -> BOOLEAN] /\ opAdmitted \in [Requests -> BOOLEAN] /\ response \in [Requests -> {"none", "success", "unavailable"}]
          /\ responseVerified \in [Requests -> BOOLEAN]
CapacityBound == Cardinality(slots) <= Limit
OutstandingRetainsSlot == \A r \in Requests: state[r] \in {"running", "timedout"} => r \in slots
OperationStartedAuthorized == \A r \in Requests: operation[r] # "none" => opAdmitted[r]
OperationSuccessVerified == \A r \in Requests: opResult[r] = "success" => opVerified[r]
ResponseSuccessVerified == \A r \in Requests: response[r] = "success" => responseVerified[r]
NeverPendingAfterTimeout == \A r \in Requests: ~(state[r] = "timedout" /\ operation[r] = "running")
NeverSuccessfulResponse == \A r \in Requests: response[r] # "success"
=============================================================================
