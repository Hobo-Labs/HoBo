-------------------------- MODULE IacPricingScope --------------------------
EXTENDS Naturals

\* This finite model checks one grant decision. An absent scope and an
\* explicitly empty (universal) scope are distinct states. It describes the
\* intended decision, not a refinement proof of the TypeScript implementation.
Fields == {"product", "rateCard", "charge", "dimension"}
Values == {"selected", "other"}

VARIABLES present, scopes, selection, decision
vars == <<present, scopes, selection, decision>>

ScopeMatches ==
  \A field \in Fields :
    scopes[field] = {} \/ selection[field] \in scopes[field]

Init ==
  /\ present \in BOOLEAN
  /\ scopes \in [Fields -> SUBSET Values]
  /\ selection \in [Fields -> Values]
  /\ decision = "pending"

Decide ==
  /\ decision = "pending"
  /\ decision' = IF present /\ ScopeMatches THEN "applied" ELSE "rejected"
  /\ UNCHANGED <<present, scopes, selection>>

Spec == Init /\ [][Decide]_vars

TypeOK ==
  /\ present \in BOOLEAN
  /\ scopes \in [Fields -> SUBSET Values]
  /\ selection \in [Fields -> Values]
  /\ decision \in {"pending", "applied", "rejected"}

AppliedRequiresExplicitScope == decision = "applied" => present
AppliedMatchesScope == decision = "applied" => ScopeMatches
MatchingExplicitScopeApplies ==
  decision = "rejected" => ~(present /\ ScopeMatches)
=============================================================================
