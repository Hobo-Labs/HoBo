------------------------- MODULE IacDestroyPricing -------------------------
EXTENDS Naturals

\* This finite model covers assessment and admission decisions, not provider
\* effects or a refinement of the TypeScript implementation. The host's
\* liability verification and unpriced authorization are represented by booleans.
Operations == {"deploy", "destroy"}
Models == {"none", "place", "destroy", "source-action", "invalid"}
Declarations == {"missing", "cancels", "no-cancellation"}
Workloads == {"add", "remove"}
Assessments == {"pending", "unavailable", "invalid", "unsupported",
                "mismatch", "incomplete", "priced"}
Routes == {"pending", "denied", "priced-held", "unpriced-held"}
Disclosures == {"not-evaluated", "allowed", "denied", "bypassed"}

VARIABLES operation, model, declaration, workload, sourceRefs,
          unpricedAuthorized, budgetAllows, assessment, route, disclosure
vars == <<operation, model, declaration, workload, sourceRefs,
          unpricedAuthorized, budgetAllows, assessment, route, disclosure>>

Init ==
  /\ operation \in Operations /\ model \in Models
  /\ declaration \in Declarations /\ workload \in Workloads
  /\ sourceRefs \in BOOLEAN /\ unpricedAuthorized \in BOOLEAN
  /\ budgetAllows \in BOOLEAN
  /\ assessment = "pending" /\ route = "pending"
  /\ disclosure = "not-evaluated"

Decision ==
  IF model = "none" THEN "unavailable"
  ELSE IF model = "invalid" THEN "invalid"
  ELSE IF model = "source-action" THEN "unsupported"
  ELSE IF operation = "destroy" /\ model # "destroy" THEN "unsupported"
  ELSE IF operation # "destroy" /\ model = "destroy" THEN "mismatch"
  ELSE IF model = "destroy" /\ declaration = "missing" THEN "incomplete"
  ELSE IF model = "destroy" /\
          (declaration = "cancels" \/ workload = "remove" \/ sourceRefs)
       THEN "unsupported"
  ELSE IF workload = "remove" THEN "unsupported"
  ELSE IF sourceRefs THEN "unsupported"
  ELSE "priced"

Assess ==
  /\ assessment = "pending"
  /\ assessment' = Decision
  /\ UNCHANGED <<operation, model, declaration, workload, sourceRefs,
                  unpricedAuthorized, budgetAllows, route, disclosure>>

RoutePriced ==
  /\ assessment = "priced" /\ route = "pending"
  /\ route' = IF budgetAllows THEN "priced-held" ELSE "denied"
  /\ disclosure' = IF budgetAllows THEN "allowed" ELSE "denied"
  /\ UNCHANGED <<operation, model, declaration, workload, sourceRefs,
                  unpricedAuthorized, budgetAllows, assessment>>

RouteUnpriced ==
  /\ assessment = "unavailable" /\ route = "pending"
  /\ route' = IF unpricedAuthorized THEN "unpriced-held" ELSE "denied"
  /\ disclosure' = IF unpricedAuthorized THEN "bypassed" ELSE "not-evaluated"
  /\ UNCHANGED <<operation, model, declaration, workload, sourceRefs,
                  unpricedAuthorized, budgetAllows, assessment>>

Refuse ==
  /\ assessment \in {"invalid", "unsupported", "mismatch", "incomplete"}
  /\ route = "pending" /\ route' = "denied"
  /\ UNCHANGED <<operation, model, declaration, workload, sourceRefs,
                  unpricedAuthorized, budgetAllows, assessment, disclosure>>

Next == Assess \/ RoutePriced \/ RouteUnpriced \/ Refuse
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ operation \in Operations /\ model \in Models
  /\ declaration \in Declarations /\ workload \in Workloads
  /\ sourceRefs \in BOOLEAN /\ unpricedAuthorized \in BOOLEAN
  /\ budgetAllows \in BOOLEAN /\ assessment \in Assessments
  /\ route \in Routes /\ disclosure \in Disclosures

DestroyQuoteIsExplicit ==
  route = "priced-held" /\ operation = "destroy" =>
    model = "destroy" /\ declaration = "no-cancellation" /\
    workload = "add" /\ ~sourceRefs
DestroyQuoteMatchesOperation ==
  route = "priced-held" => (operation = "destroy") = (model = "destroy")
UnpricedRequiresAbsenceAndAuthority ==
  route = "unpriced-held" => model = "none" /\ unpricedAuthorized /\
                               disclosure = "bypassed"
PricedRequiresBudget ==
  route = "priced-held" => budgetAllows /\ disclosure = "allowed"
SourceActionsNotPriced == model = "source-action" => route # "priced-held"
NoPricedRemoval == route = "priced-held" => workload = "add"
NoPricedSourceReference == route = "priced-held" => ~sourceRefs
NoPricedHold == route # "priced-held"
NoUnpricedHold == route # "unpriced-held"
=============================================================================
