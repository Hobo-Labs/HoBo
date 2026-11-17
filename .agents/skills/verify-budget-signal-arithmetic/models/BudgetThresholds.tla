-------------------------- MODULE BudgetThresholds --------------------------
EXTENDS Integers
CONSTANTS Current, Limit, MaxEvents
VARIABLES spent, credit, crossed, previous, signal, count
vars == <<spent, credit, crossed, previous, signal, count>>
Round(x) == ((x + 1) \div 2) * 2
Decision(s, c) == IF Current THEN s - c >= Limit ELSE Round(s - c) >= Round(Limit)
Label(was, now) == IF was = now THEN "none" ELSE IF now THEN "crossed" ELSE "recovered"
Init == /\ spent = 0 /\ credit = 0 /\ crossed = FALSE /\ previous = FALSE
        /\ signal = "none" /\ count = 0
Usage == /\ count < MaxEvents
         /\ \E amount \in 1..2:
              /\ spent' = spent + amount /\ credit' = credit
              /\ crossed' = Decision(spent + amount, credit) /\ previous' = crossed
              /\ signal' = Label(crossed, Decision(spent + amount, credit)) /\ count' = count + 1
Credit == /\ count < MaxEvents
          /\ \E amount \in 1..2:
               /\ credit' = credit + amount /\ spent' = spent
               /\ crossed' = Decision(spent, credit + amount) /\ previous' = crossed
               /\ signal' = Label(crossed, Decision(spent, credit + amount)) /\ count' = count + 1
Done == /\ count = MaxEvents /\ UNCHANGED vars
Next == Usage \/ Credit \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ spent \in 0..(2*MaxEvents) /\ credit \in 0..(2*MaxEvents)
          /\ crossed \in BOOLEAN /\ previous \in BOOLEAN
          /\ signal \in {"none", "crossed", "recovered"} /\ count \in 0..MaxEvents
CrossingCorrect == crossed = (spent - credit >= Limit)
SignalCorrect == /\ (signal = "crossed" => crossed /\ ~previous /\ spent - credit >= Limit)
                 /\ (signal = "recovered" => ~crossed /\ previous /\ spent - credit < Limit)
                 /\ (signal = "none" => crossed = previous)
=============================================================================
