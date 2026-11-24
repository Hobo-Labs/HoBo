----------------------- MODULE RivetHttpTopicBus -----------------------
EXTENDS TLC

\* Finite abstraction of one HTTP request and one bus mutation. Host authority,
\* actor identity, atomic storage, cancellation, and fencing are assumptions.
\* A timeout may precede a late commit; it is not evidence of noncommit.
VARIABLES authorized, scopeValid, dispatched, dispatchProof, effect,
          disclosed, disclosureProof, unknown

vars == <<authorized, scopeValid, dispatched, dispatchProof, effect,
          disclosed, disclosureProof, unknown>>

Init ==
  /\ authorized = TRUE
  /\ scopeValid = TRUE
  /\ dispatched = FALSE
  /\ dispatchProof = FALSE
  /\ effect = FALSE
  /\ disclosed = FALSE
  /\ disclosureProof = FALSE
  /\ unknown = FALSE

RevokeAuthorization ==
  /\ authorized
  /\ authorized' = FALSE
  /\ UNCHANGED <<scopeValid, dispatched, dispatchProof, effect,
                 disclosed, disclosureProof, unknown>>

RevokeScope ==
  /\ scopeValid
  /\ scopeValid' = FALSE
  /\ UNCHANGED <<authorized, dispatched, dispatchProof, effect,
                 disclosed, disclosureProof, unknown>>

Dispatch ==
  /\ authorized /\ scopeValid /\ ~dispatched
  /\ dispatched' = TRUE
  /\ dispatchProof' = (authorized /\ scopeValid)
  /\ UNCHANGED <<authorized, scopeValid, effect, disclosed, disclosureProof, unknown>>

Commit ==
  /\ dispatched /\ ~effect
  /\ effect' = TRUE
  /\ UNCHANGED <<authorized, scopeValid, dispatched, dispatchProof,
                 disclosed, disclosureProof, unknown>>

Disclose ==
  /\ authorized /\ scopeValid /\ effect /\ ~disclosed /\ ~unknown
  /\ disclosed' = TRUE
  /\ disclosureProof' = (authorized /\ scopeValid)
  /\ UNCHANGED <<authorized, scopeValid, dispatched, dispatchProof, effect, unknown>>

Timeout ==
  /\ dispatched /\ ~disclosed /\ ~unknown
  /\ unknown' = TRUE
  /\ UNCHANGED <<authorized, scopeValid, dispatched, dispatchProof, effect,
                 disclosed, disclosureProof>>

Next == RevokeAuthorization \/ RevokeScope \/ Dispatch \/ Commit \/ Disclose \/ Timeout
Spec == Init /\ [][Next]_vars

TypeOK == /\ authorized \in BOOLEAN /\ scopeValid \in BOOLEAN
          /\ dispatched \in BOOLEAN /\ dispatchProof \in BOOLEAN
          /\ effect \in BOOLEAN /\ disclosed \in BOOLEAN
          /\ disclosureProof \in BOOLEAN /\ unknown \in BOOLEAN
DispatchAuthorized == dispatched => dispatchProof
EffectWasDispatched == effect => dispatched
DisclosureAuthorized == disclosed => disclosureProof
DisclosureHasEffect == disclosed => effect
NoAmbiguousDisclosure == ~(unknown /\ disclosed)
NeverDisclosed == ~disclosed
NeverUnknown == ~unknown
NeverLateEffect == ~(unknown /\ effect)
=============================================================================
