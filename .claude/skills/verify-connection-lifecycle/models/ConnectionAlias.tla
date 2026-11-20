----------------------------- MODULE ConnectionAlias -----------------------------
EXTENDS Naturals
CONSTANTS GuardAlias, GuardAliasId, GuardId
VARIABLES phase, candidateId, candidateAlias, aliasTarget, added
vars == <<phase, candidateId, candidateAlias, aliasTarget, added>>
Init == /\ phase = "loaded" /\ candidateId \in {"old", "work", "other"}
        /\ candidateAlias \in {"work", "old", "fresh", "none"}
        /\ aliasTarget = "old" /\ added = FALSE
Attempt == /\ phase = "loaded"
           /\ IF candidateId = "old"
                 THEN /\ phase' = "ignored" /\ UNCHANGED <<aliasTarget, added>>
                 ELSE IF (GuardId /\ candidateId = "work") \/
                         (GuardAlias /\ candidateAlias = "work") \/
                         (GuardAliasId /\ candidateAlias = "old")
                         THEN /\ phase' = "rejected" /\ UNCHANGED <<aliasTarget, added>>
                         ELSE /\ phase' = "accepted" /\ added' = TRUE
                              /\ aliasTarget' = IF candidateAlias = "work" THEN candidateId ELSE aliasTarget
           /\ UNCHANGED <<candidateId, candidateAlias>>
Done == /\ phase \in {"ignored", "rejected", "accepted"} /\ UNCHANGED vars
Next == Attempt \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"loaded", "ignored", "rejected", "accepted"}
          /\ candidateId \in {"old", "work", "other"}
          /\ candidateAlias \in {"work", "old", "fresh", "none"}
          /\ aliasTarget \in {"old", "work", "other"} /\ added \in BOOLEAN
NoAliasRebind == aliasTarget = "old"
NamesUnambiguous == ~added \/ (candidateId # "work" /\ candidateAlias \notin {"work", "old"})
=============================================================================
