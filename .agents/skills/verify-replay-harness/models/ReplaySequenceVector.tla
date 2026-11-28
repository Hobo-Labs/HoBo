---------------------- MODULE ReplaySequenceVector ----------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Streams, SpecialNames, MaxEvents, MaxSeq, UseMap, OwnOnly
VARIABLES history, positions, own, inherited, selected, phase
vars == <<history, positions, own, inherited, selected, phase>>

Init == /\ history = <<>> /\ positions = [s \in Streams |-> 0]
        /\ own \in SUBSET Streams /\ inherited \in {{}, SpecialNames}
        /\ selected = {} /\ phase = "new"
Maximum(s) == CHOOSE n \in 0..MaxSeq:
    /\ \A i \in 1..Len(history): history[i].stream = s => history[i].seq <= n
    /\ n = 0 \/ \E i \in 1..Len(history): history[i].stream = s /\ history[i].seq = n
Add(s, n) == /\ Len(history) < MaxEvents /\ s \in Streams /\ n \in 1..MaxSeq
             /\ history' = Append(history, [stream |-> s, seq |-> n])
             /\ positions' = IF UseMap \/ s \notin SpecialNames
                              THEN [positions EXCEPT ![s] = IF n > @ THEN n ELSE @]
                              ELSE positions
             /\ UNCHANGED <<own, inherited, selected, phase>>
Select == /\ phase = "new"
          /\ selected' = IF OwnOnly THEN own ELSE own \cup inherited
          /\ phase' = "selected"
          /\ UNCHANGED <<history, positions, own, inherited>>
Done == UNCHANGED vars
Next == (\E s \in Streams, n \in 1..MaxSeq: Add(s, n)) \/ Select \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ history \in Seq([stream: Streams, seq: 1..MaxSeq])
          /\ Len(history) <= MaxEvents /\ positions \in [Streams -> 0..MaxSeq]
          /\ own \subseteq Streams /\ inherited \subseteq Streams
          /\ selected \subseteq Streams /\ phase \in {"new", "selected"}
RecordedMaximum == \A s \in Streams: positions[s] = Maximum(s)
SelectedOwnEntries == phase = "selected" => selected = own
============================================================================
