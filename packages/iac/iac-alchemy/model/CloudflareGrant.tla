--------------------------- MODULE CloudflareGrant ---------------------------
EXTENDS Naturals

\* One opt-in Worker JavaScript storage binding and one requested operation.
\* Host source, resource, and grant attestations are trusted inputs. The model
\* checks mapping decisions, not the TypeScript implementation or Cloudflare.
VARIABLES runtimeSupported, sourceAttested, resourceAttested,
          grantAttested, operationAllowed, phase
vars == <<runtimeSupported, sourceAttested, resourceAttested,
          grantAttested, operationAllowed, phase>>

Init ==
  /\ runtimeSupported \in BOOLEAN
  /\ sourceAttested \in BOOLEAN
  /\ resourceAttested \in BOOLEAN
  /\ grantAttested \in BOOLEAN
  /\ operationAllowed \in BOOLEAN
  /\ phase = "pending"

Eligible ==
  /\ runtimeSupported
  /\ sourceAttested
  /\ resourceAttested
  /\ grantAttested
  /\ operationAllowed

Decide ==
  /\ phase = "pending"
  /\ phase' = IF Eligible THEN "mapped" ELSE "refused"
  /\ UNCHANGED <<runtimeSupported, sourceAttested, resourceAttested,
                 grantAttested, operationAllowed>>

Spec == Init /\ [][Decide]_vars

TypeOK ==
  /\ runtimeSupported \in BOOLEAN /\ sourceAttested \in BOOLEAN
  /\ resourceAttested \in BOOLEAN /\ grantAttested \in BOOLEAN
  /\ operationAllowed \in BOOLEAN
  /\ phase \in {"pending", "mapped", "refused"}

MappedNeedsRuntime == phase = "mapped" => runtimeSupported
MappedNeedsSource == phase = "mapped" => sourceAttested
MappedNeedsResource == phase = "mapped" => resourceAttested
MappedNeedsGrant == phase = "mapped" => grantAttested
MappedNeedsOperation == phase = "mapped" => operationAllowed
NoMapping == phase # "mapped"
NoRefusal == phase # "refused"
=============================================================================
