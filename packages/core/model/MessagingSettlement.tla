------------------------- MODULE MessagingSettlement -------------------------
EXTENDS Naturals, FiniteSets

VARIABLES phase, lease, active, dispatches, sent, quarantine, frozen, lastSent, valid
vars == <<phase, lease, active, dispatches, sent, quarantine, frozen, lastSent, valid>>

Init ==
  /\ phase = "empty"
  /\ lease = 0
  /\ active = 0
  /\ dispatches = 0
  /\ sent = {}
  /\ quarantine = FALSE
  /\ frozen = 0
  /\ lastSent = 0
  /\ valid = TRUE

Register ==
  /\ phase \in {"empty", "ready", "settled"}
  /\ lease < 2
  /\ phase' = "ready"
  /\ lease' = lease + 1
  /\ UNCHANGED <<active, dispatches, sent, quarantine, frozen, lastSent, valid>>

Start(g) ==
  /\ phase = "ready"
  /\ g = lease /\ g \in 1..2 /\ g \notin sent
  /\ phase' = "pending"
  /\ active' = g
  /\ dispatches' = dispatches + 1
  /\ sent' = sent \cup {g}
  /\ lastSent' = g
  /\ valid' = (valid /\ g = lease)
  /\ UNCHANGED <<lease, quarantine, frozen>>

Commit ==
  /\ phase = "pending"
  /\ phase' = "settled"
  /\ active' = 0
  /\ UNCHANGED <<lease, dispatches, sent, quarantine, frozen, lastSent, valid>>

Unknown ==
  /\ phase = "pending"
  /\ phase' = "unknown"
  /\ quarantine' = TRUE
  /\ frozen' = dispatches
  /\ UNCHANGED <<lease, active, dispatches, sent, lastSent, valid>>

LateCompletion ==
  /\ phase = "unknown"
  /\ UNCHANGED vars

Spec == Init /\ [][Register \/ (\E g \in 0..2: Start(g)) \/ Commit \/ Unknown \/ LateCompletion]_vars

TypeOK ==
  /\ phase \in {"empty", "ready", "pending", "unknown", "settled"}
  /\ lease \in 0..2 /\ active \in 0..2
  /\ dispatches \in 0..2 /\ sent \subseteq 1..2
  /\ quarantine \in BOOLEAN /\ frozen \in 0..2 /\ lastSent \in 0..2 /\ valid \in BOOLEAN

ActiveNotForgotten == active # 0 => phase \in {"pending", "unknown"}
QuarantineHolds == quarantine => phase = "unknown" /\ dispatches = frozen
CurrentGenerationOnly == valid
NoDuplicateDispatch == dispatches = Cardinality(sent)
NoPending == phase # "pending"
NoUnknown == phase # "unknown"
NoReplacement == lease # 2
=============================================================================
