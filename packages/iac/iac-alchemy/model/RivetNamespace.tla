--------------------------- MODULE RivetNamespace ---------------------------
EXTENDS Naturals

\* One project mapping and one lifecycle decision. Evidence is supplied by the
\* host; this finite abstraction does not prove the implementation or Rivet.
VARIABLES configured, tokenRedacted, uniqueIdentity, dependencies,
          currentNamespace, priorNamespace, priorState, renamed, destroy, action, phase
vars == <<configured, tokenRedacted, uniqueIdentity, dependencies,
          currentNamespace, priorNamespace, priorState, renamed, destroy, action, phase>>

Actions == {"create", "noop", "update", "adopted", "replace", "delete", "orphaned"}

Init ==
  /\ configured \in BOOLEAN
  /\ tokenRedacted \in BOOLEAN
  /\ uniqueIdentity \in BOOLEAN
  /\ dependencies \in BOOLEAN
  /\ currentNamespace \in BOOLEAN
  /\ priorNamespace \in BOOLEAN
  /\ priorState \in BOOLEAN
  /\ renamed \in BOOLEAN
  /\ destroy \in BOOLEAN
  /\ action \in Actions
  /\ phase = "pending"

CanMap ==
  /\ configured
  /\ tokenRedacted
  /\ uniqueIdentity
  /\ ~dependencies

SafeLifecycle ==
  /\ IF currentNamespace
       THEN ~destroy /\ (action = "noop" \/ (action = "create" /\ ~priorState)) /\ ~renamed
       ELSE TRUE
  /\ ~priorNamespace \/ currentNamespace

Map ==
  /\ phase = "pending"
  /\ phase' = IF CanMap THEN "mapped" ELSE "refused"
  /\ UNCHANGED <<configured, tokenRedacted, uniqueIdentity, dependencies,
                 currentNamespace, priorNamespace, priorState, renamed, destroy, action>>

Inspect ==
  /\ phase = "mapped"
  /\ phase' = IF SafeLifecycle THEN "approved" ELSE "refused"
  /\ UNCHANGED <<configured, tokenRedacted, uniqueIdentity, dependencies,
                 currentNamespace, priorNamespace, priorState, renamed, destroy, action>>

Spec == Init /\ [][Map \/ Inspect]_vars

TypeOK ==
  /\ configured \in BOOLEAN /\ tokenRedacted \in BOOLEAN
  /\ uniqueIdentity \in BOOLEAN /\ dependencies \in BOOLEAN
  /\ currentNamespace \in BOOLEAN /\ priorNamespace \in BOOLEAN
  /\ priorState \in BOOLEAN
  /\ renamed \in BOOLEAN /\ destroy \in BOOLEAN /\ action \in Actions
  /\ phase \in {"pending", "mapped", "approved", "refused"}
MappedNeedsSettings == phase \in {"mapped", "approved"} => configured
MappedNeedsToken == phase \in {"mapped", "approved"} => tokenRedacted
MappedNeedsUniqueIdentity == phase \in {"mapped", "approved"} => uniqueIdentity
MappedRejectsDependencies == phase \in {"mapped", "approved"} => ~dependencies
ApprovedRetainsNamespace ==
  phase = "approved" /\ currentNamespace =>
    ~destroy /\ (action = "noop" \/ (action = "create" /\ ~priorState)) /\ ~renamed
ApprovedKeepsPriorType ==
  phase = "approved" /\ priorNamespace => currentNamespace

NoMapping == phase # "mapped"
NoApproval == phase # "approved"
NoRefusal == phase # "refused"
NoDeleteRefusal ==
  ~(phase = "refused" /\ CanMap /\ currentNamespace /\ action = "delete")
NoAliasRefusal ==
  ~(phase = "refused" /\ CanMap /\ priorNamespace /\ ~currentNamespace)
NoUncertainCreateRefusal ==
  ~(phase = "refused" /\ CanMap /\ currentNamespace /\ priorState /\ action = "create")
NoDestroyNoopRefusal ==
  ~(phase = "refused" /\ CanMap /\ currentNamespace /\ destroy /\ action = "noop")
=============================================================================
