-------------------------- MODULE DeclaredTopics --------------------------
EXTENDS Naturals, TLC

Declared == {"orders", "dead-letter"}
VARIABLES topics, effects, receipt, authority, valid, pinned, active,
          response, creationProof, sawUnknown
vars == <<topics, effects, receipt, authority, valid, pinned, active,
          response, creationProof, sawUnknown>>

Init ==
  /\ topics = {} /\ effects = 0 /\ receipt = "none"
  /\ authority = TRUE /\ valid \in BOOLEAN
  /\ pinned = "unset" /\ active = "A" /\ response = "none"
  /\ creationProof = FALSE /\ sawUnknown = FALSE

Commit(result) ==
  /\ authority /\ valid /\ receipt = "none"
  /\ pinned \in {"unset", active}
  /\ result \in {"committed", "unknown"}
  /\ topics' = Declared
  /\ effects' = effects + 1
  /\ receipt' = "committed" /\ pinned' = active
  /\ creationProof' = authority
  /\ response' = result /\ sawUnknown' = (sawUnknown \/ result = "unknown")
  /\ UNCHANGED <<authority, valid, active>>

Reject ==
  /\ authority /\ ~valid /\ receipt = "none"
  /\ pinned \in {"unset", active}
  /\ receipt' = "rejected" /\ pinned' = active /\ response' = "rejected"
  /\ UNCHANGED <<topics, effects, authority, valid, active, creationProof, sawUnknown>>

Abort ==
  /\ receipt = "none"
  /\ response' = "unknown" /\ sawUnknown' = TRUE
  /\ UNCHANGED <<topics, effects, receipt, authority, valid, pinned, active, creationProof>>

Replay ==
  /\ authority /\ pinned = active /\ receipt \in {"committed", "rejected"}
  /\ response' = receipt
  /\ UNCHANGED <<topics, effects, receipt, authority, valid, pinned, active,
                 creationProof, sawUnknown>>

ChangeAuthority ==
  /\ authority' = ~authority
  /\ UNCHANGED <<topics, effects, receipt, valid, pinned, active, response,
                 creationProof, sawUnknown>>

ChangeDigest ==
  /\ active' = IF active = "A" THEN "B" ELSE "A"
  /\ UNCHANGED <<topics, effects, receipt, authority, valid, pinned, response,
                 creationProof, sawUnknown>>

Next == (\E result \in {"committed", "unknown"}: Commit(result)) \/ Reject \/
        Abort \/ Replay \/ ChangeAuthority \/ ChangeDigest
Spec == Init /\ [][Next]_vars

TypeOK == /\ topics \subseteq Declared /\ effects \in 0..2
          /\ receipt \in {"none", "committed", "rejected"}
          /\ authority \in BOOLEAN /\ valid \in BOOLEAN
          /\ pinned \in {"unset", "A", "B"} /\ active \in {"A", "B"}
          /\ response \in {"none", "committed", "rejected", "unknown"}
          /\ creationProof \in BOOLEAN /\ sawUnknown \in BOOLEAN
CreationAuthorized == topics # {} => creationProof
EffectIncludesTopics == effects > 0 => topics = Declared
ReceiptMatchesEffect == (receipt = "committed") <=> (effects = 1)
NoDuplicateEffect == effects <= 1
RejectedHasNoTopics == receipt = "rejected" => topics = {}
NeverRecovered == ~(sawUnknown /\ response = "committed")
=============================================================================
