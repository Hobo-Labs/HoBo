------------------------- MODULE BudgetSignalReplay -------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES record, transition, phase
vars == <<record, transition, phase>>
Records == {"none", "exact", "foreign", "collision", "changed", "mixed", "occupied", "incomplete", "orphan"}
Transitions == {"reset", "crossed", "recovered"}
Init == /\ record \in Records /\ transition \in Transitions /\ phase = "pending"
Conflict == record \in {"collision", "changed", "mixed", "occupied"}
Suppress == /\ phase = "pending"
            /\ (record = "exact" \/ (~Current /\ record \in {"collision", "changed", "mixed"}))
            /\ phase' = "suppressed" /\ UNCHANGED <<record, transition>>
Refuse == /\ phase = "pending" /\ Current /\ (Conflict \/ record \in {"incomplete", "orphan"})
          /\ phase' = "refused" /\ UNCHANGED <<record, transition>>
Emit == /\ phase = "pending"
        /\ (record \in {"none", "foreign"} \/ (~Current /\ record \in {"occupied", "incomplete"}))
        /\ phase' = "emitted" /\ UNCHANGED <<record, transition>>
IgnoreOrphan == /\ phase = "pending" /\ ~Current /\ record = "orphan"
                /\ phase' = "ignored" /\ UNCHANGED <<record, transition>>
Append == /\ phase = "emitted"
          /\ phase' = IF record = "occupied" THEN "deduped" ELSE "delivered"
          /\ UNCHANGED <<record, transition>>
Done == /\ phase \in {"suppressed", "refused", "delivered", "deduped", "ignored"} /\ UNCHANGED vars
Next == Suppress \/ Refuse \/ Emit \/ IgnoreOrphan \/ Append \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ record \in Records /\ transition \in Transitions
          /\ phase \in {"pending", "suppressed", "refused", "emitted", "delivered", "deduped", "ignored"}
OnlyIdenticalSuppresses == phase = "suppressed" => record = "exact"
ConflictsDoNotReturn == Conflict => phase \notin {"suppressed", "emitted", "delivered", "deduped"}
IncompleteDoesNotReturn == record = "incomplete" => phase \notin {"suppressed", "emitted", "delivered", "deduped"}
ExactDoesNotEmit == record = "exact" => phase \notin {"emitted", "delivered", "deduped"}
ForeignDoesNotBlock == record = "foreign" => phase \notin {"suppressed", "refused", "deduped"}
NoSilentJournalDedup == phase # "deduped"
NoOrphanReturn == record = "orphan" => phase # "ignored"
=============================================================================
