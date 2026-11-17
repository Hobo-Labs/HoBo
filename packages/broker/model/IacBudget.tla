------------------------------ MODULE IacBudget ------------------------------
EXTENDS Naturals, FiniteSets

\* Two independently scheduled operations share one canonical budget/account.
\* External exclusive-scope, usage and retirement verifiers are trusted at
\* ReserveUnpriced and VerifyRetirement; their implementations are not modeled.
\* Guard authentication and host settlement-trust enrollment are also trusted.
\* Trust can change between reserve and claim, modeling a reopen. A claim and
\* provider start are abstracted as one step under the host's fencing lease.
\* No liveness is assumed if those authorities remain unavailable.
Ops == {"one", "two"}
Limit == 2
States == {"idle", "held", "claimed", "uncertain", "settled", "released"}
Modes == {"none", "priced", "unpriced"}
Active == {"held", "claimed", "uncertain"}

VARIABLES status, mode, live, fenced, verified, spent, disclosure,
          settlementTrust, guarded, admissionAuthorized, startAuthorized
vars == <<status, mode, live, fenced, verified, spent, disclosure,
          settlementTrust, guarded, admissionAuthorized, startAuthorized>>

Init ==
  /\ status = [o \in Ops |-> "idle"]
  /\ mode = [o \in Ops |-> "none"]
  /\ live = [o \in Ops |-> FALSE]
  /\ fenced = [o \in Ops |-> FALSE]
  /\ verified = [o \in Ops |-> FALSE]
  /\ spent = 0
  /\ disclosure = [o \in Ops |-> "not-evaluated"]
  /\ settlementTrust \in BOOLEAN
  /\ guarded = [o \in Ops |-> FALSE]
  /\ admissionAuthorized = [o \in Ops |-> FALSE]
  /\ startAuthorized = [o \in Ops |-> FALSE]

ActivePriced == {o \in Ops : status[o] \in Active /\ mode[o] = "priced"}
ActiveUnpriced == {o \in Ops : status[o] \in Active /\ mode[o] = "unpriced"}

ReservePriced(o, guard) ==
  /\ status[o] = "idle" /\ ActiveUnpriced = {}
  /\ guard \in BOOLEAN /\ (settlementTrust \/ guard)
  /\ spent + Cardinality(ActivePriced) + 1 <= Limit
  /\ status' = [status EXCEPT ![o] = "held"]
  /\ mode' = [mode EXCEPT ![o] = "priced"]
  /\ disclosure' = [disclosure EXCEPT ![o] = "evaluated"]
  /\ guarded' = [guarded EXCEPT ![o] = guard]
  /\ admissionAuthorized' = [admissionAuthorized EXCEPT ![o] = settlementTrust \/ guard]
  /\ UNCHANGED <<live, fenced, verified, spent, settlementTrust, startAuthorized>>

ReserveUnpriced(o) ==
  /\ status[o] = "idle" /\ ActivePriced = {} /\ ActiveUnpriced = {}
  /\ status' = [status EXCEPT ![o] = "held"]
  /\ mode' = [mode EXCEPT ![o] = "unpriced"]
  /\ disclosure' = [disclosure EXCEPT ![o] = "bypassed"]
  /\ UNCHANGED <<live, fenced, verified, spent, settlementTrust, guarded,
                 admissionAuthorized, startAuthorized>>

Claim(o) ==
  /\ status[o] = "held"
  /\ mode[o] # "priced" \/ settlementTrust \/ guarded[o]
  /\ status' = [status EXCEPT ![o] = "claimed"]
  /\ live' = [live EXCEPT ![o] = TRUE]
  /\ startAuthorized' = [startAuthorized EXCEPT ![o] =
                          mode[o] # "priced" \/ settlementTrust \/ guarded[o]]
  /\ UNCHANGED <<mode, fenced, verified, spent, disclosure, settlementTrust,
                 guarded, admissionAuthorized>>

LoseAcknowledgement(o) ==
  /\ status[o] = "claimed"
  /\ status' = [status EXCEPT ![o] = "uncertain"]
  /\ UNCHANGED <<mode, live, fenced, verified, spent, disclosure, settlementTrust,
                 guarded, admissionAuthorized, startAuthorized>>

Fence(o) ==
  /\ status[o] \in {"claimed", "uncertain"} /\ live[o]
  /\ live' = [live EXCEPT ![o] = FALSE]
  /\ fenced' = [fenced EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<status, mode, verified, spent, disclosure, settlementTrust,
                 guarded, admissionAuthorized, startAuthorized>>

VerifyRetirement(o) ==
  /\ status[o] \in {"claimed", "uncertain"} /\ fenced[o] /\ ~live[o]
  /\ verified' = [verified EXCEPT ![o] = TRUE]
  /\ UNCHANGED <<status, mode, live, fenced, spent, disclosure, settlementTrust,
                 guarded, admissionAuthorized, startAuthorized>>

Settle(o, actual) ==
  /\ status[o] \in {"claimed", "uncertain"}
  /\ fenced[o] /\ verified[o] /\ ~live[o] /\ actual \in 0..3
  /\ status' = [status EXCEPT ![o] = "settled"]
  /\ spent' = spent + actual
  /\ UNCHANGED <<mode, live, fenced, verified, disclosure, settlementTrust,
                 guarded, admissionAuthorized, startAuthorized>>

ReleaseUnused(o) ==
  /\ status[o] = "held" /\ ~live[o]
  /\ status' = [status EXCEPT ![o] = "released"]
  /\ UNCHANGED <<mode, live, fenced, verified, spent, disclosure, settlementTrust,
                 guarded, admissionAuthorized, startAuthorized>>

ReopenTrust ==
  /\ settlementTrust' = ~settlementTrust
  /\ UNCHANGED <<status, mode, live, fenced, verified, spent, disclosure,
                 guarded, admissionAuthorized, startAuthorized>>

Next == \E o \in Ops :
  \/ (\E guard \in BOOLEAN : ReservePriced(o, guard)) \/ ReserveUnpriced(o) \/ Claim(o)
  \/ LoseAcknowledgement(o) \/ Fence(o) \/ VerifyRetirement(o)
  \/ ReleaseUnused(o) \/ \E actual \in 0..3 : Settle(o, actual)
  \/ ReopenTrust

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in [Ops -> States] /\ mode \in [Ops -> Modes]
  /\ live \in [Ops -> BOOLEAN] /\ fenced \in [Ops -> BOOLEAN]
  /\ verified \in [Ops -> BOOLEAN] /\ spent \in Nat
  /\ disclosure \in [Ops -> {"not-evaluated", "evaluated", "bypassed"}]
  /\ settlementTrust \in BOOLEAN /\ guarded \in [Ops -> BOOLEAN]
  /\ admissionAuthorized \in [Ops -> BOOLEAN] /\ startAuthorized \in [Ops -> BOOLEAN]
NoMixedExposure == ActivePriced = {} \/ ActiveUnpriced = {}
LiveHasHold == \A o \in Ops : live[o] => status[o] \in {"claimed", "uncertain"}
NoLiveTerminal == \A o \in Ops : status[o] \in {"settled", "released"} => ~live[o]
UnknownIsDisclosed == \A o \in Ops : mode[o] = "unpriced" => disclosure[o] = "bypassed"
SettlementRequiresEvidence == \A o \in Ops : status[o] = "settled" => fenced[o] /\ verified[o]
PricedReservationHasSettlementPath ==
  \A o \in Ops : mode[o] = "priced" => admissionAuthorized[o]
PricedStartHasSettlementPath ==
  \A o \in Ops : mode[o] = "priced" /\ status[o] \in {"claimed", "uncertain", "settled"}
                 => startAuthorized[o]

=============================================================================
