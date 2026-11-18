------------------- MODULE RollbackExecutionFence -------------------
EXTENDS Naturals, FiniteSets
\* One request key, two distinct attempt tokens, one atomic journal. A
\* response may be lost or forged; the stored claim is assumed truthful.
CONSTANTS Workers, CheckUnique, CheckStored, CheckAck, CheckLegacy
None == "none"
Other(w) == CHOOSE v \in Workers : v # w
VARIABLES protocol, owner, phase, reply, effects, badOwner, badReply, badLegacy
vars == <<protocol, owner, phase, reply, effects, badOwner, badReply, badLegacy>>

Init == /\ protocol \in {"current", "legacy"}
        /\ owner = None /\ phase = [w \in Workers |-> "new"]
        /\ reply = [w \in Workers |-> None] /\ effects = {}
        /\ badOwner = FALSE /\ badReply = FALSE /\ badLegacy = FALSE

Claim(w) == /\ phase[w] = "new"
            /\ (owner = None \/ ~CheckUnique)
            /\ owner' = w /\ reply' = [reply EXCEPT ![w] = w]
            /\ phase' = [phase EXCEPT ![w] = "observed"]
            /\ UNCHANGED <<protocol, effects, badOwner, badReply, badLegacy>>
Compete(w) == /\ phase[w] = "new" /\ owner # None
              /\ reply' = [reply EXCEPT ![w] = owner]
              /\ phase' = [phase EXCEPT ![w] = "observed"]
              /\ UNCHANGED <<protocol, owner, effects, badOwner, badReply, badLegacy>>
CommitLost(w) == /\ phase[w] = "new" /\ owner = None
                 /\ owner' = w /\ phase' = [phase EXCEPT ![w] = "lost"]
                 /\ UNCHANGED <<protocol, reply, effects, badOwner, badReply, badLegacy>>
FailBefore(w) == /\ phase[w] = "new"
                 /\ phase' = [phase EXCEPT ![w] = "lost"]
                 /\ UNCHANGED <<protocol, owner, reply, effects, badOwner, badReply, badLegacy>>
ForgedAck(w) == /\ phase[w] = "new"
                /\ reply' = [reply EXCEPT ![w] = w]
                /\ phase' = [phase EXCEPT ![w] = "observed"]
                /\ UNCHANGED <<protocol, owner, effects, badOwner, badReply, badLegacy>>
WrongAck(w) == /\ phase[w] = "new" /\ owner = None
               /\ owner' = w /\ reply' = [reply EXCEPT ![w] = Other(w)]
               /\ phase' = [phase EXCEPT ![w] = "observed"]
               /\ UNCHANGED <<protocol, effects, badOwner, badReply, badLegacy>>
Effect(w) == /\ phase[w] = "observed"
             /\ (owner = w \/ ~CheckStored)
             /\ (reply[w] = w \/ ~CheckAck)
             /\ (protocol = "current" \/ ~CheckLegacy)
             /\ effects' = effects \cup {w}
             /\ badOwner' = (badOwner \/ owner # w)
             /\ badReply' = (badReply \/ reply[w] # w)
             /\ badLegacy' = (badLegacy \/ protocol = "legacy")
             /\ phase' = [phase EXCEPT ![w] = "done"]
             /\ UNCHANGED <<protocol, owner, reply>>
Done == UNCHANGED vars
Next == (\E w \in Workers : Claim(w) \/ Compete(w) \/ CommitLost(w)
                      \/ FailBefore(w) \/ ForgedAck(w) \/ WrongAck(w) \/ Effect(w))
        \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ protocol \in {"current", "legacy"}
          /\ owner \in Workers \cup {None}
          /\ phase \in [Workers -> {"new", "lost", "observed", "done"}]
          /\ reply \in [Workers -> Workers \cup {None}]
          /\ effects \subseteq Workers
          /\ badOwner \in BOOLEAN /\ badReply \in BOOLEAN /\ badLegacy \in BOOLEAN
AtMostOneEffect == Cardinality(effects) <= 1
StoredClaimBeforeEffect == ~badOwner
MatchingAckBeforeEffect == ~badReply
NoUnfinishedLegacyEffect == ~badLegacy
=====================================================================
