--------------------------- MODULE YardBinding -------------------------------
EXTENDS Naturals, Sequences
CONSTANTS ExactBinding, RequireUnique
VARIABLES wantA, wantB, wrongA, wrongB, unique, phase, unitA, unitB
facts == <<wantA, wantB, wrongA, wrongB, unique>>
vars == <<wantA, wantB, wrongA, wrongB, unique, phase, unitA, unitB>>
Init == /\ wantA \in {"x", "y"} /\ wantB \in {"x", "y"}
        /\ wrongA \in BOOLEAN /\ wrongB \in BOOLEAN /\ unique \in BOOLEAN
        /\ phase = "input" /\ unitA = <<>> /\ unitB = <<>>
Bind == /\ phase = "input" /\ (unique \/ ~RequireUnique)
        /\ unitA' = IF ExactBinding THEN <<wantA>> ELSE IF wrongA THEN <<wantB>> ELSE <<>>
        /\ unitB' = IF ExactBinding THEN <<wantB>> ELSE IF wrongB THEN <<wantA>> ELSE <<>>
        /\ phase' = "bound" /\ UNCHANGED facts
Refuse == /\ phase = "input" /\ ~unique /\ RequireUnique
          /\ phase' = "rejected" /\ UNCHANGED <<facts, unitA, unitB>>
Done == /\ phase \in {"bound", "rejected"} /\ UNCHANGED vars
Next == Bind \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ wantA \in {"x", "y"} /\ wantB \in {"x", "y"}
          /\ wrongA \in BOOLEAN /\ wrongB \in BOOLEAN /\ unique \in BOOLEAN
          /\ phase \in {"input", "bound", "rejected"}
          /\ unitA \in {<<>>, <<"x">>, <<"y">>}
          /\ unitB \in {<<>>, <<"x">>, <<"y">>}
CorrectA == phase = "bound" => unitA = <<wantA>>
CorrectB == phase = "bound" => unitB = <<wantB>>
UniqueUnits == phase = "bound" => unique
=============================================================================
