-------------------------- MODULE AwsGraphCapture --------------------------
EXTENDS Naturals, Sequences, FiniteSets

Names == {"cache", "assets"}
Kinds == {"kv", "bucket"}
Range(seq) == {seq[i] : i \in 1..Len(seq)}
Distinct(seq) == Cardinality(Range(seq)) = Len(seq)

VARIABLES kindOf, appKind, uiOp, phase, inputEdges, inputDeclared, capturedEdges, capturedDeclared,
          methodsChanged, bound, acceptedEdges, acceptedDeclared
vars == <<kindOf, appKind, uiOp, phase, inputEdges, inputDeclared, capturedEdges, capturedDeclared,
          methodsChanged, bound, acceptedEdges, acceptedDeclared>>

CountsMatch(edges, declared) ==
  \A kind \in Kinds:
    Cardinality({i \in 1..Len(edges): kindOf[edges[i]] = kind}) =
    Cardinality({i \in 1..Len(declared): declared[i] = kind})

Init ==
  /\ kindOf \in [Names -> Kinds] /\ phase = "initial"
  /\ appKind \in {"web", "ui"} /\ uiOp \in {"none", "render", "drive"}
  /\ (appKind = "web" => uiOp = "none")
  /\ inputEdges \in {<<"cache", "assets">>, <<"cache", "cache">>}
  /\ inputDeclared \in {<<"kv", "bucket">>, <<"kv", "kv">>}
  /\ capturedEdges = <<>> /\ capturedDeclared = <<>>
  /\ methodsChanged = FALSE /\ bound = <<>>
  /\ acceptedEdges = <<>> /\ acceptedDeclared = <<>>

Snapshot ==
  /\ phase = "initial" /\ phase' = "captured"
  /\ capturedEdges' = inputEdges /\ capturedDeclared' = inputDeclared
  /\ UNCHANGED <<kindOf, appKind, uiOp, inputEdges, inputDeclared, methodsChanged, bound,
                 acceptedEdges, acceptedDeclared>>

ChangeMethods ==
  /\ phase = "captured" /\ ~methodsChanged /\ methodsChanged' = TRUE
  /\ UNCHANGED <<kindOf, appKind, uiOp, phase, inputEdges, inputDeclared, capturedEdges,
                 capturedDeclared, bound, acceptedEdges, acceptedDeclared>>

ChangeInput ==
  /\ phase = "captured" /\ inputEdges' = <<"cache">>
  /\ inputDeclared' = <<"kv">>
  /\ UNCHANGED <<kindOf, appKind, uiOp, phase, capturedEdges, capturedDeclared, methodsChanged,
                 bound, acceptedEdges, acceptedDeclared>>

Accept ==
  /\ phase = "captured"
  /\ (appKind # "ui" \/ uiOp = "none")
  /\ Distinct(capturedEdges)
  /\ Len(capturedEdges) = Len(capturedDeclared)
  /\ CountsMatch(capturedEdges, capturedDeclared)
  /\ phase' = "accepted" /\ bound' = capturedEdges
  /\ acceptedEdges' = capturedEdges /\ acceptedDeclared' = capturedDeclared
  /\ UNCHANGED <<kindOf, appKind, uiOp, inputEdges, inputDeclared, capturedEdges, capturedDeclared,
                 methodsChanged>>

Reject ==
  /\ phase = "captured"
  /\ ~(Distinct(capturedEdges) /\ Len(capturedEdges) = Len(capturedDeclared)
       /\ CountsMatch(capturedEdges, capturedDeclared)
       /\ (appKind # "ui" \/ uiOp = "none"))
  /\ phase' = "rejected"
  /\ UNCHANGED <<kindOf, appKind, uiOp, inputEdges, inputDeclared, capturedEdges, capturedDeclared,
                 methodsChanged, bound, acceptedEdges, acceptedDeclared>>

Spec == Init /\ [][Snapshot \/ ChangeMethods \/ ChangeInput \/ Accept \/ Reject]_vars
TypeOK == /\ kindOf \in [Names -> Kinds]
          /\ appKind \in {"web", "ui"} /\ uiOp \in {"none", "render", "drive"}
          /\ phase \in {"initial", "captured", "accepted", "rejected"}
          /\ methodsChanged \in BOOLEAN
          /\ Range(inputEdges) \subseteq Names /\ Range(inputDeclared) \subseteq Kinds
          /\ Range(bound) \subseteq Names
UiOperationsNotGranted == (phase = "accepted" /\ appKind = "ui") => uiOp = "none"
NoUiAccepted == ~(phase = "accepted" /\ appKind = "ui")
NoUiOperationRejected == ~(phase = "rejected" /\ appKind = "ui" /\ uiOp # "none")
NoDuplicateBindings == phase = "accepted" => Distinct(bound)
BindingsMatchDeclarations == phase = "accepted" =>
  /\ Len(bound) = Len(acceptedDeclared)
  /\ CountsMatch(bound, acceptedDeclared)
BindingsMatchSnapshot == phase = "accepted" => bound = acceptedEdges
NoAcceptedAfterMethodChange == ~(phase = "accepted" /\ methodsChanged)
NoRejectedGraph == ~(phase = "rejected")
NoSameKindAccepted == ~(phase = "accepted" /\ kindOf["cache"] = kindOf["assets"])
NoInputChangeBeforeAcceptance == ~(phase = "accepted" /\ inputEdges # acceptedEdges)
=============================================================================
