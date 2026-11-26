package collection_coverage

#CoverageFailureCode:
	"collection.coverage.unobserved-resource" |
	"collection.coverage.cannot-prove-resource-name" |
	"collection.coverage.unobserved-bind" |
	"collection.coverage.cannot-prove-bind" |
	"collection.coverage.unreachable-resource" |
	"collection.coverage.unreachable-bind"

#DeclaredResource: {
	resource_id: string & !=""
	callee:      string & !=""
	file_name:   string & !=""
	line:        int & >=1
	branch:      string & !=""
	reachable:   bool
	evidence:    string & !=""
}

#DeclaredBind: {
	from:      string & !=""
	to:        string & !=""
	key:       string & !=""
	file_name: string & !=""
	line:      int & >=1
	branch:    string & !=""
	reachable: bool
	evidence:  string & !=""
}

#UnresolvedDeclaration: {
	callee:    string & !=""
	argument:  string
	file_name: string & !=""
	line:      int & >=1
	branch:    string & !=""
	reason:    string & !=""
}

#CoverageDiagnostic: {
	code:        #CoverageFailureCode | string
	severity:    "error" | "warning"
	message:     string & !=""
	resource_id?: string
	bind_key?:    string
	branch?:      string
	file_name?:   string
	line?:        int
	callee?:      string
}

#CoverageResult: {
	ok:                   bool
	can_deploy_dimension: "collectionCoverage"
	status:               "pass" | "pass-with-warnings" | "fail"
	observed_resource_ids: [...string]
	observed_bind_keys:    [...string]
	declared_resources:    [...#DeclaredResource]
	declared_binds:        [...#DeclaredBind]
	unobserved_declarations: [...#DeclaredResource]
	unobserved_binds:        [...#DeclaredBind]
	unreachable_declarations: [...#DeclaredResource]
	unreachable_binds:        [...#DeclaredBind]
	unresolved_declarations:  [...#UnresolvedDeclaration]
	unresolved_binds:         [...#UnresolvedDeclaration]
	diagnostics:              [...#CoverageDiagnostic]
}
