-------------------------- MODULE TrainingTraceSink --------------------------
EXTENDS Integers, Sequences
CONSTANTS CopySpan, CopyAttributes, ResetOnDrain
VARIABLES sourceName, sourceAttr, nameChanged, attrChanged, queue, expected,
          output, expectedOutput, records, drains
vars == <<sourceName, sourceAttr, nameChanged, attrChanged, queue, expected,
          output, expectedOutput, records, drains>>
ChangeName(s) == [i \in 1..Len(s) |-> [s[i] EXCEPT !.name = "changed"]]
ChangeAttr(s) == [i \in 1..Len(s) |-> [s[i] EXCEPT !.attr = "changed"]]
Init == /\ sourceName = "original" /\ sourceAttr = "original"
        /\ nameChanged = FALSE /\ attrChanged = FALSE
        /\ queue = <<>> /\ expected = <<>> /\ output = <<>> /\ expectedOutput = <<>>
        /\ records = 0 /\ drains = 0
Record == /\ records < 2
          /\ queue' = Append(queue, [name |-> sourceName, attr |-> sourceAttr])
          /\ expected' = Append(expected, [name |-> sourceName, attr |-> sourceAttr])
          /\ records' = records + 1
          /\ UNCHANGED <<sourceName, sourceAttr, nameChanged, attrChanged, output, expectedOutput, drains>>
MutateName == /\ ~nameChanged /\ sourceName' = "changed" /\ nameChanged' = TRUE
              /\ queue' = (IF CopySpan THEN queue ELSE ChangeName(queue))
              /\ output' = (IF CopySpan THEN output ELSE ChangeName(output))
              /\ UNCHANGED <<sourceAttr, attrChanged, expected, expectedOutput, records, drains>>
MutateAttr == /\ ~attrChanged /\ sourceAttr' = "changed" /\ attrChanged' = TRUE
              /\ queue' = (IF CopyAttributes THEN queue ELSE ChangeAttr(queue))
              /\ output' = (IF CopyAttributes THEN output ELSE ChangeAttr(output))
              /\ UNCHANGED <<sourceName, nameChanged, expected, expectedOutput, records, drains>>
Drain == /\ drains < 2 /\ output' = queue /\ expectedOutput' = expected
         /\ queue' = (IF ResetOnDrain THEN <<>> ELSE queue) /\ expected' = <<>>
         /\ drains' = drains + 1
         /\ UNCHANGED <<sourceName, sourceAttr, nameChanged, attrChanged, records>>
Wait == UNCHANGED vars
Next == Record \/ MutateName \/ MutateAttr \/ Drain \/ Wait
Spec == Init /\ [][Next]_vars
RecordType == [name: {"original", "changed"}, attr: {"original", "changed"}]
TypeOK == /\ sourceName \in {"original", "changed"} /\ sourceAttr \in {"original", "changed"}
          /\ nameChanged \in BOOLEAN /\ attrChanged \in BOOLEAN
          /\ queue \in Seq(RecordType) /\ expected \in Seq(RecordType)
          /\ output \in Seq(RecordType) /\ expectedOutput \in Seq(RecordType)
          /\ records \in 0..2 /\ drains \in 0..2
QueueCorrect == queue = expected
DrainCorrect == output = expectedOutput
=============================================================================
