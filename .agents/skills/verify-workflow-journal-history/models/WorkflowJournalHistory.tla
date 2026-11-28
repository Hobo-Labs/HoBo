------------------------ MODULE WorkflowJournalHistory ------------------------
EXTENDS Integers, Sequences
CONSTANTS CheckSequence, CheckType, CheckFirst, CheckUnique, CheckTerminal, CheckKnown
VARIABLES phase, mode, kinds, positions
vars == <<phase, mode, kinds, positions>>

Modes == {"resume", "replay"}
KindCases == {
  <<"start", "app", "terminal">>,
  <<"start", "app", "app">>,
  <<"start", "start", "terminal">>,
  <<"app", "start", "terminal">>,
  <<"app", "app", "terminal">>,
  <<"start", "terminal", "app">>,
  <<"start", "terminal", "terminal">>,
  <<"start", "unknown", "terminal">>,
  <<"start", "invalid", "terminal">>
}
PositionCases == {<<1, 2, 3>>, <<1, 3, 4>>, <<2, 3, 4>>, <<1, 1, 3>>}
SequenceOK == \A i \in 1..3 : positions[i] = i
TypesOK == \A i \in 1..3 : kinds[i] # "invalid"
FirstOK == kinds[1] = "start"
UniqueOK == \A i \in 2..3 : kinds[i] # "start"
TerminalOK == \A i \in 1..2 : kinds[i] # "terminal"
KnownOK == \A i \in 1..3 : kinds[i] # "unknown"
Valid == SequenceOK /\ TypesOK /\ FirstOK /\ UniqueOK /\ TerminalOK /\ KnownOK
Accepted == (CheckSequence => SequenceOK) /\ (CheckType => TypesOK)
            /\ (CheckFirst => FirstOK) /\ (CheckUnique => UniqueOK)
            /\ (CheckTerminal => TerminalOK) /\ (CheckKnown => KnownOK)

Init == /\ phase = "received" /\ mode \in Modes
        /\ kinds \in KindCases /\ positions \in PositionCases
Check == /\ phase = "received"
         /\ phase' = IF Accepted THEN "checked" ELSE "refused"
         /\ UNCHANGED <<mode, kinds, positions>>
Use == /\ phase = "checked" /\ phase' = "used"
       /\ UNCHANGED <<mode, kinds, positions>>
Done == /\ phase \in {"used", "refused"} /\ UNCHANGED vars
Next == Check \/ Use \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "checked", "refused", "used"}
          /\ mode \in Modes
          /\ kinds \in KindCases /\ positions \in PositionCases
SafeUse == phase = "used" => Valid
=============================================================================
