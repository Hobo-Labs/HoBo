------------------------- MODULE CloudflareSecret -------------------------
EXTENDS Naturals

\* One infrastructure-only secret declaration. The host supplies the store,
\* inventory and fingerprint attestations. This model describes decisions;
\* it is not a refinement proof of the TypeScript code or Cloudflare.
VARIABLES storeKnown, valueRedacted, uniqueIdentity, runtimeRequested,
          fingerprintVerified, inventoryMatches, phase
vars == <<storeKnown, valueRedacted, uniqueIdentity, runtimeRequested,
          fingerprintVerified, inventoryMatches, phase>>

Init ==
  /\ storeKnown \in BOOLEAN
  /\ valueRedacted \in BOOLEAN
  /\ uniqueIdentity \in BOOLEAN
  /\ runtimeRequested \in BOOLEAN
  /\ fingerprintVerified \in BOOLEAN
  /\ inventoryMatches \in BOOLEAN
  /\ phase = "pending"

CanMap ==
  /\ storeKnown
  /\ valueRedacted
  /\ uniqueIdentity
  /\ ~runtimeRequested

Map ==
  /\ phase = "pending"
  /\ phase' = IF CanMap THEN "mapped" ELSE "refused"
  /\ UNCHANGED <<storeKnown, valueRedacted, uniqueIdentity, runtimeRequested,
                 fingerprintVerified, inventoryMatches>>

Preview ==
  /\ phase = "mapped"
  /\ phase' = IF fingerprintVerified /\ inventoryMatches
               THEN "previewed" ELSE "refused"
  /\ UNCHANGED <<storeKnown, valueRedacted, uniqueIdentity, runtimeRequested,
                 fingerprintVerified, inventoryMatches>>

Spec == Init /\ [][Map \/ Preview]_vars

TypeOK ==
  /\ storeKnown \in BOOLEAN /\ valueRedacted \in BOOLEAN
  /\ uniqueIdentity \in BOOLEAN /\ runtimeRequested \in BOOLEAN
  /\ fingerprintVerified \in BOOLEAN /\ inventoryMatches \in BOOLEAN
  /\ phase \in {"pending", "mapped", "previewed", "refused"}
MappedNeedsStore == phase \in {"mapped", "previewed"} => storeKnown
MappedNeedsRedaction == phase \in {"mapped", "previewed"} => valueRedacted
MappedNeedsUniqueIdentity == phase \in {"mapped", "previewed"} => uniqueIdentity
MappedRejectsRuntime == phase \in {"mapped", "previewed"} => ~runtimeRequested
PreviewNeedsEvidence == phase = "previewed" => fingerprintVerified /\ inventoryMatches

NoMapping == phase # "mapped"
NoPreview == phase # "previewed"
NoRefusal == phase # "refused"
=============================================================================
