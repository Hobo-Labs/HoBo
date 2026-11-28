--------------------------- MODULE HttpUiMapping ---------------------------
EXTENDS Naturals

VARIABLES provider, kind, operation, sourceAttested, replayEnabled, phase
vars == <<provider, kind, operation, sourceAttested, replayEnabled, phase>>

Init ==
  /\ provider \in {"aws", "rivet", "cloudflare"}
  /\ kind \in {"web", "ui"}
  /\ operation \in {"none", "render", "drive"}
  /\ (kind = "web" => operation = "none")
  /\ sourceAttested \in BOOLEAN /\ replayEnabled \in BOOLEAN
  /\ phase = "pending"

Eligible ==
  /\ sourceAttested
  /\ ~replayEnabled
  /\ (kind # "ui" \/ operation = "none")

Decide ==
  /\ phase = "pending"
  /\ phase' = IF Eligible THEN "mapped" ELSE "refused"
  /\ UNCHANGED <<provider, kind, operation, sourceAttested, replayEnabled>>

Spec == Init /\ [][Decide]_vars
TypeOK ==
  /\ provider \in {"aws", "rivet", "cloudflare"}
  /\ kind \in {"web", "ui"} /\ operation \in {"none", "render", "drive"}
  /\ sourceAttested \in BOOLEAN /\ replayEnabled \in BOOLEAN
  /\ phase \in {"pending", "mapped", "refused"}
UiOperationsNotMapped == (phase = "mapped" /\ kind = "ui") => operation = "none"
MappingNeedsSource == phase = "mapped" => sourceAttested
MappingDisablesReplay == phase = "mapped" => ~replayEnabled
NoAwsUi == ~(phase = "mapped" /\ kind = "ui" /\ provider = "aws")
NoRivetUi == ~(phase = "mapped" /\ kind = "ui" /\ provider = "rivet")
NoCloudflareUi == ~(phase = "mapped" /\ kind = "ui" /\ provider = "cloudflare")
NoUiRejection == ~(phase = "refused" /\ kind = "ui" /\ operation # "none")
=============================================================================
