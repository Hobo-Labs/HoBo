------------------------------ MODULE IacBudget ------------------------------
EXTENDS Naturals, FiniteSets

\* Two independently scheduled operations share one canonical budget/account.
\* External exclusive-scope, usage and retirement verifiers are trusted at
\* ReserveUnpriced and VerifyRetirement; their implementations are not modeled.
\* No liveness is assumed if those authorities remain unavailable.
Ops == {"one", "two"}
Limit == 2
States == {"idle", "held", "claimed", "uncertain", "settled", "released"}
Modes == {"none", "priced", "unpriced"}
Active == {"held", "claimed", "uncertain"}

VARIABLES status, mode, live, fenced, verified, spent, disclosure
vars == <<status, mode, live, fenced, verified, spent, disclosure>>

Init ==
  /\ status = [o \in Ops |-> "idle"]
  /\ mode = [o \in Ops |-> "none"]
  /\ live = [o \in Ops |-> FALSE]
  /\ fenced = [o \in Ops |-> FALSE]
  /\ verified = [o \in Ops |-> FALSE]
  /\ spent = 0
  /\ disclosure = [o \in Ops |-> "not-evaluated"]

ActivePriced == {o \in Ops : status[o] \in Active /\ mode[o] = "priced"}
ActiveUnpriced == {o \in Ops : status[o] \in Active /\ mode[o] = "unpriced"}

ReservePriced(o) ==
  /\ status[o] = "idle" /\ ActiveUnpriced = {}
  /\ spent + Cardinality(ActivePriced) + 1 <= Limit
  /\ status' = [status EXCEPT ![o] = "held"]
  /\ mode' = [mode EXCEPT ![o] = "priced"]
  /\ disclosure' = [disclosure EXCEPT ![o] = "evaluated"]
  /\ UNCHANGED <<live, fenced, verified, spent>>

ReserveUnpriced(o) ==
  /\ status[o] = "idle" /\ ActivePriced = {} /\ ActiveUnpriced = {}
  /\ status' = [status EXCEPT ![o] = "held"]
  /\ mode' = [mode EXCEPT ![o] = "unpriced"]
  /\ disclosure' = [disclosure EXCEPT ![o] = "bypassed"]
  /\ UNCHANGED <<live, fenced, verified, spent>>

Claim(o) ==
  /\ status[o] = "held"
  /\ status' = [status EXCEPT ![o] = "claimed"]
  /\ live' = [live EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<mode, fenced, verified, spent, disclosure>>

LoseAcknowledgement(o) ==
  /\ status[o] = "claimed"
  /\ status' = [status EXCEPT ![o] = "uncertain"]
  /\ UNCHANGED <<mode, live, fenced, verified, spent, disclosure>>

Fence(o) ==
  /\ status[o] \in {"claimed", "uncertain"} /\ live[o]
  /\ live' = [live EXCEPT ![o] = FALSE]
  /\ fenced' = [fenced EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<status, mode, verified, spent, disclosure>>

VerifyRetirement(o) ==
  /\ status[o] \in {"claimed", "uncertain"} /\ fenced[o] /\ ~live[o]
  /\ verified' = [verified EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<status, mode, live, fenced, spent, disclosure>>

Settle(o, actual) ==
  /\ status[o] \in {"claimed", "uncertain"}
  /\ fenced[o] /\ verified[o] /\ ~live[o] /\ actual \in 0..3
  /\ status' = [status EXCEPT ![o] = "settled"]
  /\ spent' = spent + actual
  /\ UNCHANGED <<mode, live, fenced, verified, disclosure>>

ReleaseUnused(o) ==
  /\ status[o] = "held" /\ ~live[o]
  /\ status' = [status EXCEPT ![o] = "released"]
  /\ UNCHANGED <<mode, live, fenced, verified, spent, disclosure>>

Next == \E o \in Ops :
  \/ ReservePriced(o) \/ ReserveUnpriced(o) \/ Claim(o)
  \/ LoseAcknowledgement(o) \/ Fence(o) \/ VerifyRetirement(o)
  \/ ReleaseUnused(o) \/ \E actual \in 0..3 : Settle(o, actual)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in [Ops -> States] /\ mode \in [Ops -> Modes]
  /\ live \in [Ops -> BOOLEAN] /\ fenced \in [Ops -> BOOLEAN]
  /\ verified \in [Ops -> BOOLEAN] /\ spent \in Nat
  /\ disclosure \in [Ops -> {"not-evaluated", "evaluated", "bypassed"}]
NoMixedExposure == ActivePriced = {} \/ ActiveUnpriced = {}
LiveHasHold == \A o \in Ops : live[o] => status[o] \in {"claimed", "uncertain"}
NoLiveTerminal == \A o \in Ops : status[o] \in {"settled", "released"} => ~live[o]
UnknownIsDisclosed == \A o \in Ops : mode[o] = "unpriced" => disclosure[o] = "bypassed"
SettlementRequiresEvidence == \A o \in Ops : status[o] = "settled" => fenced[o] /\ verified[o]

=============================================================================
