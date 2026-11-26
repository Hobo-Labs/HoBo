------------------------- MODULE AwsSecretVersions -------------------------
EXTENDS Naturals, FiniteSets, TLC

\* The caller persists the chosen token before dispatch. AWS idempotency,
\* host authorization, timeout delivery and transport completion are assumptions.
CONSTANTS Tokens, Payloads
VARIABLES state, slot, grant, token, payload, versions, writes, response, responseVerified
vars == <<state, slot, grant, token, payload, versions, writes, response, responseVerified>>
Init ==
  /\ state = "idle" /\ slot = FALSE /\ grant = TRUE
  /\ token = (CHOOSE t \in Tokens: TRUE) /\ payload = (CHOOSE p \in Payloads: TRUE)
  /\ versions = [t \in Tokens |-> "none"] /\ writes = [t \in Tokens |-> 0]
  /\ response = "none" /\ responseVerified = FALSE
Start(t, p) ==
  /\ state = "idle" /\ grant /\ ~slot
  /\ state' = "running" /\ slot' = TRUE /\ token' = t /\ payload' = p
  /\ response' = "none" /\ responseVerified' = FALSE
  /\ UNCHANGED <<grant, versions, writes>>
Commit ==
  /\ state \in {"running", "timedout"} /\ versions[token] = "none"
  /\ versions' = [versions EXCEPT ![token] = payload]
  /\ writes' = [writes EXCEPT ![token] = @ + 1]
  /\ UNCHANGED <<state, slot, grant, token, payload, response, responseVerified>>
Confirm ==
  /\ state = "running" /\ versions[token] = payload
  /\ state' = "done" /\ slot' = FALSE
  /\ response' = IF grant THEN "success" ELSE "unknown"
  /\ responseVerified' = grant
  /\ UNCHANGED <<grant, token, payload, versions, writes>>
Conflict ==
  /\ state = "running" /\ versions[token] \in Payloads /\ versions[token] # payload
  /\ state' = "done" /\ slot' = FALSE /\ response' = "unknown"
  /\ UNCHANGED <<grant, token, payload, versions, writes, responseVerified>>
Timeout ==
  /\ state = "running" /\ state' = "timedout" /\ response' = "unknown"
  /\ UNCHANGED <<slot, grant, token, payload, versions, writes, responseVerified>>
FinishTimedout ==
  /\ state = "timedout" /\ state' = "done" /\ slot' = FALSE
  /\ UNCHANGED <<grant, token, payload, versions, writes, response, responseVerified>>
Reset ==
  /\ state = "done" /\ state' = "idle" /\ response' = "none" /\ responseVerified' = FALSE
  /\ UNCHANGED <<slot, grant, token, payload, versions, writes>>
ChangeGrant == /\ grant' = ~grant /\ UNCHANGED <<state, slot, token, payload, versions, writes, response, responseVerified>>
Next == (\E t \in Tokens, p \in Payloads: Start(t, p)) \/ Commit \/ Confirm \/ Conflict \/ Timeout \/ FinishTimedout \/ Reset \/ ChangeGrant
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in {"idle", "running", "timedout", "done"} /\ slot \in BOOLEAN /\ grant \in BOOLEAN
          /\ token \in Tokens /\ payload \in Payloads /\ versions \in [Tokens -> Payloads \cup {"none"}]
          /\ writes \in [Tokens -> 0..2] /\ response \in {"none", "success", "unknown"} /\ responseVerified \in BOOLEAN
OneVersionPerToken == \A t \in Tokens: writes[t] <= 1
TimeoutRetainsSlot == state = "timedout" => slot
SuccessIsConfirmed == response = "success" => responseVerified /\ versions[token] = payload
NeverSuccess == response # "success"
NeverTimeout == state # "timedout"
=============================================================================
