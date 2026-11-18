------------------------- MODULE YardQuotaMigration --------------------------
EXTENDS Naturals
CONSTANTS CheckScope, CheckLegacyFence, CheckOldGuard
VARIABLES migrated, guarded, fenced, wrongTried, wrongMutated, oldTried, oldWriteAfter
vars == <<migrated, guarded, fenced, wrongTried, wrongMutated, oldTried, oldWriteAfter>>
Init == /\ migrated = FALSE /\ guarded = FALSE /\ fenced = FALSE
        /\ wrongTried = FALSE /\ wrongMutated = FALSE /\ oldTried = FALSE /\ oldWriteAfter = FALSE
WrongScope == /\ ~wrongTried /\ wrongTried' = TRUE
              /\ wrongMutated' = ~CheckScope
              /\ UNCHANGED <<migrated, guarded, fenced, oldTried, oldWriteAfter>>
Upgrade == /\ ~migrated /\ migrated' = TRUE /\ guarded' = TRUE
           /\ fenced' = CheckLegacyFence
           /\ UNCHANGED <<wrongTried, wrongMutated, oldTried, oldWriteAfter>>
OldWrite == /\ ~oldTried /\ oldTried' = TRUE
            /\ oldWriteAfter' = (migrated /\ (~guarded \/ ~CheckOldGuard))
            /\ UNCHANGED <<migrated, guarded, fenced, wrongTried, wrongMutated>>
Done == /\ migrated /\ UNCHANGED vars
Next == WrongScope \/ Upgrade \/ OldWrite \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ migrated \in BOOLEAN /\ guarded \in BOOLEAN /\ fenced \in BOOLEAN
          /\ wrongTried \in BOOLEAN /\ wrongMutated \in BOOLEAN /\ oldTried \in BOOLEAN /\ oldWriteAfter \in BOOLEAN
NoWrongScopeMutation == ~wrongMutated
LegacyClaimsFenced == migrated => fenced
NoOldWriteAfterUpgrade == ~oldWriteAfter
=============================================================================
