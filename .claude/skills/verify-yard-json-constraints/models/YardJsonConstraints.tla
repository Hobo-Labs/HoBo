----------------------- MODULE YardJsonConstraints -----------------------
EXTENDS Naturals
CONSTANTS SafeMap, FreezeArrays, StructuralMatch, StructuralRank
Cases == {"equal-structured", "different-structured", "special-key"}
VARIABLES inputCase, phase, preserved, snapshot, matched, rank
vars == <<inputCase, phase, preserved, snapshot, matched, rank>>
Init == /\ inputCase \in Cases /\ phase = "parse" /\ preserved = FALSE
        /\ snapshot = "original" /\ matched = FALSE /\ rank = 0
Parse == /\ phase = "parse"
         /\ preserved' = (inputCase # "special-key" \/ SafeMap)
         /\ phase' = "ready"
         /\ UNCHANGED <<inputCase, snapshot, matched, rank>>
EditArray == /\ phase = "ready" /\ ~FreezeArrays /\ snapshot = "original"
             /\ snapshot' = "changed"
             /\ UNCHANGED <<inputCase, phase, preserved, matched, rank>>
Match == /\ phase = "ready"
         /\ matched' = (inputCase # "different-structured" /\
                        (inputCase # "equal-structured" \/ StructuralMatch))
         /\ rank' = IF inputCase = "equal-structured" /\ StructuralRank THEN 1 ELSE 0
         /\ phase' = "done"
         /\ UNCHANGED <<inputCase, preserved, snapshot>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == Parse \/ EditArray \/ Match \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ inputCase \in Cases /\ phase \in {"parse", "ready", "done"}
          /\ preserved \in BOOLEAN /\ snapshot \in {"original", "changed"}
          /\ matched \in BOOLEAN /\ rank \in 0..1
SpecialKeyPreserved == phase # "parse" /\ inputCase = "special-key" => preserved
SnapshotImmutable == snapshot = "original"
EqualMatches == phase = "done" /\ inputCase = "equal-structured" => matched
EqualRanks == phase = "done" /\ inputCase = "equal-structured" => rank = 1
DifferentRefused == phase = "done" /\ inputCase = "different-structured" => ~matched
=============================================================================
