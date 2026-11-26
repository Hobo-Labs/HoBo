// CUE constraints for the Redis-compatible conformance model.
//
// These are the invariants the TypeScript parse boundaries enforce, written
// where a reviewer can read them without reading the implementation. There is
// no buf module here on purpose: these types are documentation-and-invariant
// only, so `pnpm run codegen` correctly leaves them alone.

package kv_redis_compatible

import "strings"

#ConformanceArea: "transport" | "key-value" | "ttl" | "atomicity" |
	"bounded-payload" | "consistency"

// A case is only ever evidence for a kv profile. Widening this union is how a
// queue claim would sneak in, so it is closed on purpose.
#CaseProfileId: "kv.key-value/v1" | "kv.redis-compatible/v1"

#FillKind: "max-value-bytes" | "over-max-value-bytes"

#CommandArgTemplate: string | {fill: #FillKind}

#CommandTemplate: [string, ...#CommandArgTemplate]

#RedisValue: string | number | null | #RedisValueArray

// The recursive arm, named so the protobuf projection has something to point
// at: proto3 has no anonymous list-of-oneof.
#RedisValueArray: [...#RedisValue]

#ReplyExpectationKind: "value" | "one-of" | "integer-between" | "error" | "byte-length"

#ReplyExpectation: {kind: "value", value: #RedisValue} |
	{kind: "one-of", values: [...#RedisValue]} |
	{kind: "integer-between", min: int, max: int & >=min} |
	{kind: "error"} |
	{kind: "byte-length", of: #FillKind}

#ConformanceStep: {
	command: #CommandTemplate
	expect:  #ReplyExpectation
	// Requires the executor to expose time control. Absent control skips the
	// case; it never passes it.
	waitMs?: int & >0
}

#ConformanceCase: {
	id:        string & =~"^[a-z][a-z0-9-]*\\.[a-z0-9-]+$"
	area:      #ConformanceArea
	profileId: #CaseProfileId
	title:     string & !=""
	// A case without a stated reason is a case nobody can decide to delete.
	rationale: string & strings.MinRunes(40)
	steps: [#ConformanceStep, ...#ConformanceStep]
	substantiates: [...string]
	optional?: bool
}

#CaseOutcome: "pass" | "fail" | "skipped"

#StepResult: {
	// The resolved command as it reached the store, keys already prefixed.
	command: string & !=""
	outcome: "pass" | "fail"
	// A failing step has to say what it saw, or the report is unactionable.
	detail: string
	if outcome == "fail" {
		detail: string & !=""
	}
}

#ConformanceCaseResult: {
	caseId:    string
	area:      #ConformanceArea
	profileId: #CaseProfileId
	outcome:   #CaseOutcome
	reason:    string & !=""
	steps: [...#StepResult]
	// A failing case is the one whose steps contain the failure. A case that
	// reports `pass` while a step failed would be the bug this rules out.
	if outcome == "pass" {
		steps: [...(#StepResult & {outcome: "pass"})]
	}
	// A skipped case records no steps: nothing ran, so nothing is claimed.
	if outcome == "skipped" {
		steps: []
	}
}

#RunOutcome: "pass" | "fail" | "incomplete"

#ConformanceReport: {
	suiteRef:  string & !=""
	transport: "rest" | "resp" | "in-process"
	outcome:   #RunOutcome
	results: [...#ConformanceCaseResult]
	substantiatedCapabilities: [...string]
	failedCaseIds: [...string]
	skippedCaseIds: [...string]

	// The three rules that keep a report from over-claiming.
	if len(failedCaseIds) > 0 {
		outcome: "fail"
	}
	if len(failedCaseIds) == 0 && len(skippedCaseIds) > 0 {
		outcome: "incomplete"
	}
	if len(failedCaseIds) == 0 && len(skippedCaseIds) == 0 {
		outcome: "pass"
	}
}

// A consistency property the suite either stands behind or explicitly does not.
#ConsistencyClaim: {
	asserted: bool
	key:      string & !=""
	note:     string & !=""
	// An asserted property must name the case that establishes it; an
	// unasserted one must not pretend to have evidence.
	if asserted {
		conformanceCaseId: string & !=""
	}
	if !asserted {
		conformanceCaseId?: _|_
	}
}
