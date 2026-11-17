---------------------- MODULE BindleRuntimeInference --------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS MaxItems, CheckOci, CheckWasm, NoInventOci, NoInventWasm, PreserveDeclared, PreserveMixed
Kinds == {"http", "container", "wasm-component"}
Runtimes == {"oci", "wasm"}
Inputs == UNION { [1..n -> Kinds] : n \in 0..MaxItems }
VARIABLES resources, remaining, declared, inferred, result, phase
vars == <<resources, remaining, declared, inferred, result, phase>>
HasKind(kind) == \E i \in 1..Len(resources): resources[i] = kind
Init == /\ resources \in Inputs /\ remaining = resources /\ declared \in SUBSET Runtimes
        /\ inferred = {} /\ result = {} /\ phase = "collect"
Collect == /\ phase = "collect" /\ Len(remaining) > 0
           /\ inferred' = CASE Head(remaining) = "container" /\ CheckOci -> inferred \cup {"oci"}
                            [] Head(remaining) = "wasm-component" /\ CheckWasm -> inferred \cup {"wasm"}
                            [] Head(remaining) = "http" /\ ~NoInventOci -> inferred \cup {"oci"}
                            [] Head(remaining) = "http" /\ ~NoInventWasm -> inferred \cup {"wasm"}
                            [] OTHER -> inferred
           /\ remaining' = Tail(remaining)
           /\ UNCHANGED <<resources, declared, result, phase>>
Finish == /\ phase = "collect" /\ Len(remaining) = 0
          /\ LET all == inferred \cup (IF PreserveDeclared THEN declared ELSE {})
             IN result' = IF ~PreserveMixed /\ "oci" \in all THEN all \ {"wasm"} ELSE all
          /\ phase' = "done"
          /\ UNCHANGED <<resources, remaining, declared, inferred>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == Collect \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ resources \in Inputs /\ remaining \in Inputs /\ declared \in SUBSET Runtimes
          /\ inferred \in SUBSET Runtimes /\ result \in SUBSET Runtimes /\ phase \in {"collect", "done"}
RequiredOci == phase = "done" /\ HasKind("container") => "oci" \in result
RequiredWasm == phase = "done" /\ HasKind("wasm-component") => "wasm" \in result
DeclaredPreserved == phase = "done" => declared \subseteq result
NoUnneededOci == phase = "done" /\ ~HasKind("container") /\ "oci" \notin declared => "oci" \notin result
NoUnneededWasm == phase = "done" /\ ~HasKind("wasm-component") /\ "wasm" \notin declared => "wasm" \notin result
=============================================================================
