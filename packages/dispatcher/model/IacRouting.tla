----------------------------- MODULE IacRouting -----------------------------
EXTENDS Naturals, FiniteSets

\* A finite abstraction of one authenticated logical operation shared by all
\* candidates. Host scope, fence and financial evidence are trusted only at
\* the explicit VerifyNoEffect transition. Each target is tried at most once.
\* No liveness is assumed when the host cannot provide verified evidence.
Targets == {"priced", "unpriced"}
None == "none"

VARIABLES phase, routeKind, allowUnpriced, candidate, tried, permit,
          pricedHold, unpricedHold, live, fenced, verified, disclosure

vars == <<phase, routeKind, allowUnpriced, candidate, tried, permit,
          pricedHold, unpricedHold, live, fenced, verified, disclosure>>

Init ==
  /\ phase = "idle"
  /\ routeKind = None
  /\ allowUnpriced = FALSE
  /\ candidate = None
  /\ tried = {}
  /\ permit = None
  /\ pricedHold = FALSE
  /\ unpricedHold = FALSE
  /\ live = {}
  /\ fenced = {}
  /\ verified = FALSE
  /\ disclosure = "not-evaluated"

Begin(kind, allow) ==
  /\ phase = "idle"
  /\ kind \in {"ranked", "explicit"}
  /\ allow \in BOOLEAN
  /\ phase' = "routing"
  /\ routeKind' = kind
  /\ allowUnpriced' = allow
  /\ UNCHANGED <<candidate, tried, permit, pricedHold, unpricedHold, live,
                 fenced, verified, disclosure>>

Select(target) ==
  /\ phase = "routing"
  /\ candidate = None
  /\ target \in Targets \ tried
  /\ (target = "priced" \/ (routeKind = "explicit" /\ allowUnpriced))
  /\ candidate' = target
  /\ permit' = "issued"
  /\ verified' = FALSE
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, tried, pricedHold,
                 unpricedHold, live, fenced, disclosure>>

Reserve ==
  /\ phase = "routing" /\ candidate \in Targets /\ permit = "issued"
  /\ ~pricedHold /\ ~unpricedHold
  /\ IF candidate = "priced"
        THEN /\ pricedHold' = TRUE
             /\ unpricedHold' = FALSE
             /\ disclosure' = "evaluated"
        ELSE /\ pricedHold' = FALSE
             /\ unpricedHold' = TRUE
             /\ disclosure' = "bypassed"
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, candidate, tried, permit,
                 live, fenced, verified>>

Invoke ==
  /\ phase = "routing" /\ candidate \in Targets /\ permit = "issued"
  /\ (pricedHold \/ unpricedHold)
  /\ live = {}
  /\ permit' = "consumed"
  /\ live' = {candidate}
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, candidate, tried,
                 pricedHold, unpricedHold, fenced, verified, disclosure>>

Denial ==
  /\ phase = "routing" /\ candidate \in Targets /\ permit = "issued"
  /\ ~pricedHold /\ ~unpricedHold
  /\ tried' = tried \cup {candidate}
  /\ candidate' = None
  /\ permit' = None
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, pricedHold, unpricedHold,
                 live, fenced, verified, disclosure>>

LoseAcknowledgement ==
  /\ phase = "routing" /\ candidate \in Targets
  /\ (pricedHold \/ unpricedHold \/ permit = "consumed")
  /\ phase' = "uncertain"
  /\ UNCHANGED <<routeKind, allowUnpriced, candidate, tried, permit,
                 pricedHold, unpricedHold, live, fenced, verified, disclosure>>

Finish ==
  /\ phase = "routing" /\ permit = "consumed" /\ candidate \in live
  /\ phase' = "selected"
  /\ UNCHANGED <<routeKind, allowUnpriced, candidate, tried, permit,
                 pricedHold, unpricedHold, live, fenced, verified, disclosure>>

Fence ==
  /\ phase = "uncertain" /\ candidate \in Targets
  /\ live' = live \ {candidate}
  /\ fenced' = fenced \cup {candidate}
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, candidate, tried, permit,
                 pricedHold, unpricedHold, verified, disclosure>>

VerifyNoEffect ==
  /\ phase = "uncertain" /\ candidate \in fenced /\ candidate \notin live
  /\ verified' = TRUE
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, candidate, tried, permit,
                 pricedHold, unpricedHold, live, fenced, disclosure>>

Settle ==
  /\ phase = "uncertain" /\ verified /\ candidate \in fenced
  /\ candidate \notin live
  /\ (pricedHold \/ unpricedHold)
  /\ pricedHold' = FALSE
  /\ unpricedHold' = FALSE
  /\ UNCHANGED <<phase, routeKind, allowUnpriced, candidate, tried, permit,
                 live, fenced, verified, disclosure>>

Recover ==
  /\ phase = "uncertain" /\ candidate \in fenced /\ verified
  /\ ~pricedHold /\ ~unpricedHold /\ live = {}
  /\ phase' = "routing"
  /\ tried' = tried \cup {candidate}
  /\ candidate' = None
  /\ permit' = None
  /\ verified' = FALSE
  /\ disclosure' = "not-evaluated"
  /\ UNCHANGED <<routeKind, allowUnpriced, pricedHold, unpricedHold, live, fenced>>

Next ==
  \/ \E kind \in {"ranked", "explicit"}, allow \in BOOLEAN : Begin(kind, allow)
  \/ \E target \in Targets : Select(target)
  \/ Reserve \/ Invoke \/ Denial \/ LoseAcknowledgement \/ Finish
  \/ Fence \/ VerifyNoEffect \/ Settle \/ Recover

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"idle", "routing", "uncertain", "selected"}
  /\ routeKind \in {None, "ranked", "explicit"}
  /\ allowUnpriced \in BOOLEAN
  /\ candidate \in Targets \cup {None}
  /\ tried \subseteq Targets /\ live \subseteq Targets /\ fenced \subseteq Targets
  /\ permit \in {None, "issued", "consumed"}
  /\ pricedHold \in BOOLEAN /\ unpricedHold \in BOOLEAN /\ verified \in BOOLEAN
  /\ disclosure \in {"not-evaluated", "evaluated", "bypassed"}

OneLiveEffect == Cardinality(live) <= 1
NoMixedExposure == ~(pricedHold /\ unpricedHold)
UnpricedIsDisclosed == unpricedHold => disclosure = "bypassed" /\ routeKind = "explicit" /\ allowUnpriced
RankedIsPriced == routeKind = "ranked" => candidate # "unpriced"
NoUnfencedFallback == phase = "routing" /\ candidate # None => live = {} \/ live = {candidate}
UncertainRetainsAuthority == phase = "uncertain" /\ ~verified => pricedHold \/ unpricedHold \/ permit = "consumed"
LiveRequiresConsumedPermit == live # {} => permit = "consumed" /\ (pricedHold \/ unpricedHold)
NoUnverifiedDischarge == phase = "uncertain" /\ ~pricedHold /\ ~unpricedHold => verified /\ candidate \in fenced
RoutingCannotOvertake == phase = "routing" /\ live # {} => candidate \in live /\ permit = "consumed"
EvidenceAfterFence == verified => candidate \in fenced /\ candidate \notin live

=============================================================================
