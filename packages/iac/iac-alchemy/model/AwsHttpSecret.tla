------------------------- MODULE AwsHttpSecret -------------------------
EXTENDS Naturals, TLC

\* One request and one write. The host verifier, the captured token, the
\* provider's idempotency and transport completion are trusted assumptions.
CONSTANTS Tokens
VARIABLES request, grant, operation, token, result, reported, verified
vars == <<request, grant, operation, token, result, reported, verified>>
Init ==
  /\ request = "idle" /\ grant = TRUE /\ operation = "none"
  /\ token = (CHOOSE t \in Tokens: TRUE)
  /\ result = "none" /\ reported = "none" /\ verified = FALSE
Start == /\ request = "idle" /\ grant /\ request' = "active"
         /\ UNCHANGED <<grant, operation, token, result, reported, verified>>
Begin(t) ==
  /\ request = "active" /\ grant /\ operation = "none"
  /\ operation' = "pending" /\ token' = t
  /\ UNCHANGED <<request, grant, result, reported, verified>>
Finish ==
  /\ operation = "pending" /\ operation' = "done"
  /\ result' = IF request = "active" /\ grant THEN "success" ELSE "unknown"
  /\ reported' = IF request = "active" /\ grant THEN "none" ELSE token
  /\ verified' = (request = "active" /\ grant)
  /\ UNCHANGED <<request, grant, token>>
Retire == /\ request = "active" /\ request' = "retired"
          /\ UNCHANGED <<grant, operation, token, result, reported, verified>>
ChangeGrant == /\ grant' = ~grant
               /\ UNCHANGED <<request, operation, token, result, reported, verified>>
Next == Start \/ (\E t \in Tokens: Begin(t)) \/ Finish \/ Retire \/ ChangeGrant
Spec == Init /\ [][Next]_vars
TypeOK == /\ request \in {"idle", "active", "retired"} /\ grant \in BOOLEAN
          /\ operation \in {"none", "pending", "done"} /\ token \in Tokens
          /\ result \in {"none", "success", "unknown"} /\ reported \in Tokens \cup {"none"} /\ verified \in BOOLEAN
SuccessVerified == result = "success" => verified
UnknownIdentifiesWrite == result = "unknown" => reported = token
NeverUnknown == result # "unknown"
NeverSuccess == result # "success"
=============================================================================
