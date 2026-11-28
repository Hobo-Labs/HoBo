---------------------------- MODULE TopicJournal ----------------------------
EXTENDS Naturals

VARIABLES phase, authority, expired, activeDigest, requestDigest, pinnedDigest,
          receipt, effects, outcome, attempts, startedAuthorized, startedInTime,
          disclosureAuthorized, effectBeforeAttempt, sawUnknown
vars == <<phase, authority, expired, activeDigest, requestDigest, pinnedDigest,
          receipt, effects, outcome, attempts, startedAuthorized, startedInTime,
          disclosureAuthorized, effectBeforeAttempt, sawUnknown>>

Init ==
  /\ phase = "idle" /\ authority = TRUE /\ expired = FALSE
  /\ activeDigest = "A" /\ requestDigest = "none" /\ pinnedDigest = "none"
  /\ receipt = FALSE /\ effects = 0 /\ outcome = "none" /\ attempts = 0
  /\ startedAuthorized = FALSE /\ startedInTime = FALSE
  /\ disclosureAuthorized = FALSE /\ effectBeforeAttempt = 0 /\ sawUnknown = FALSE

ChangeAuthority ==
  /\ authority' = ~authority
  /\ UNCHANGED <<phase, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, outcome, attempts, startedAuthorized,
                 startedInTime, disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
Expire ==
  /\ ~expired /\ expired' = TRUE
  /\ UNCHANGED <<phase, authority, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, outcome, attempts, startedAuthorized,
                 startedInTime, disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
ChangeDigest ==
  /\ activeDigest' = IF activeDigest = "A" THEN "B" ELSE "A"
  /\ UNCHANGED <<phase, authority, expired, requestDigest, pinnedDigest,
                 receipt, effects, outcome, attempts, startedAuthorized,
                 startedInTime, disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
Start ==
  /\ phase = "idle" /\ attempts < 3 /\ authority /\ ~expired
  /\ pinnedDigest \in {"none", activeDigest}
  /\ phase' = "running" /\ attempts' = attempts + 1
  /\ requestDigest' = activeDigest /\ effectBeforeAttempt' = effects
  /\ startedAuthorized' = authority /\ startedInTime' = ~expired
  /\ UNCHANGED <<authority, expired, activeDigest, pinnedDigest, receipt, effects,
                 outcome, disclosureAuthorized, sawUnknown>>
UncertainBeforeStart ==
  /\ phase = "idle" /\ attempts < 3
  /\ (~authority \/ pinnedDigest \notin {"none", activeDigest})
  /\ phase' = "done" /\ outcome' = "unknown" /\ attempts' = attempts + 1
  /\ effectBeforeAttempt' = effects
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, startedAuthorized, startedInTime,
                 disclosureAuthorized, sawUnknown>>
ExpiredAttempt ==
  /\ phase = "idle" /\ attempts < 3 /\ expired /\ authority
  /\ pinnedDigest \in {"none", activeDigest}
  /\ phase' = "done" /\ outcome' = "expired" /\ attempts' = attempts + 1
  /\ effectBeforeAttempt' = effects
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, startedAuthorized, startedInTime,
                 disclosureAuthorized, sawUnknown>>
Commit ==
  /\ phase = "running" /\ ~receipt
  /\ phase' = "committed" /\ receipt' = TRUE /\ effects' = effects + 1
  /\ pinnedDigest' = requestDigest
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, outcome,
                 attempts, startedAuthorized, startedInTime,
                 disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
Replay ==
  /\ phase = "running" /\ receipt /\ pinnedDigest = requestDigest
  /\ phase' = "committed"
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, outcome, attempts, startedAuthorized,
                 startedInTime, disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
Abort ==
  /\ phase = "running" /\ phase' = "done" /\ outcome' = "unknown"
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, attempts, startedAuthorized, startedInTime,
                 disclosureAuthorized, effectBeforeAttempt, sawUnknown>>
Disclose ==
  /\ phase = "committed" /\ authority
  /\ phase' = "done" /\ outcome' = "committed"
  /\ disclosureAuthorized' = authority
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, attempts, startedAuthorized, startedInTime,
                 effectBeforeAttempt, sawUnknown>>
UnknownAfterCommit ==
  /\ phase = "committed" /\ phase' = "done" /\ outcome' = "unknown"
  /\ sawUnknown' = TRUE
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, attempts, startedAuthorized, startedInTime,
                 disclosureAuthorized, effectBeforeAttempt>>
Retry ==
  /\ phase = "done" /\ attempts < 3 /\ phase' = "idle" /\ outcome' = "none"
  /\ UNCHANGED <<authority, expired, activeDigest, requestDigest, pinnedDigest,
                 receipt, effects, attempts, startedAuthorized, startedInTime,
                 disclosureAuthorized, effectBeforeAttempt, sawUnknown>>

Next == ChangeAuthority \/ Expire \/ ChangeDigest \/ Start \/ UncertainBeforeStart \/
        ExpiredAttempt \/ Commit \/ Replay \/ Abort \/ Disclose \/ UnknownAfterCommit \/ Retry
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "running", "committed", "done"}
          /\ authority \in BOOLEAN /\ expired \in BOOLEAN
          /\ activeDigest \in {"A", "B"}
          /\ requestDigest \in {"none", "A", "B"}
          /\ pinnedDigest \in {"none", "A", "B"}
          /\ receipt \in BOOLEAN /\ effects \in 0..2 /\ attempts \in 0..3
          /\ outcome \in {"none", "unknown", "committed", "expired"}
          /\ startedAuthorized \in BOOLEAN /\ startedInTime \in BOOLEAN
          /\ disclosureAuthorized \in BOOLEAN /\ effectBeforeAttempt \in 0..2
          /\ sawUnknown \in BOOLEAN
NoDuplicateEffect == effects <= 1
ReceiptMatchesEffect == receipt <=> effects = 1
StartAuthorized == phase \in {"running", "committed"} => startedAuthorized
StartInTime == phase \in {"running", "committed"} => startedInTime
DisclosureAuthorized == outcome = "committed" => disclosureAuthorized
ExpiredDoesNotApply == outcome = "expired" => effects = effectBeforeAttempt
NoUnknownAfterEffect == ~(outcome = "unknown" /\ effects = 1)
NoUnknownWithoutEffect == ~(outcome = "unknown" /\ effects = 0)
NoExpiredAfterEffect == ~(outcome = "expired" /\ effects = 1)
NoCommitAfterExpiry == ~(outcome = "committed" /\ expired)
NoUnknownRecovered == ~(sawUnknown /\ outcome = "committed" /\ effects = 1)
NoDigestMismatch == ~(outcome = "unknown" /\ pinnedDigest = "A" /\ activeDigest = "B")
=============================================================================
