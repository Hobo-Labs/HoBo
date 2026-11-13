# `@hobo/policy/posture`

Observe-phase posture rules, the pure posture evaluator and the OSCAL
assessment-results export (ADR-0182: D25). Dependency-free, like the rest of
`@hobo/policy`. `@hobo/cd`'s Station-side posture service is the only caller
that turns evaluations into journal records; agents never evaluate posture.

| File | Holds |
|---|---|
| `rules.ts` | The rule profile (`hobo.policy-ir/v1`, profile `hobo.posture/v1`), `parsePosturePack`, `observeFields` |
| `semver.ts` | SemVer 2.0.0 precedence for `semver-gte` |
| `evaluate.ts` | `evaluateClause`, `evaluatePosture`, `effectiveRemediation`, `resolvePostureBindings` |
| `oscal.ts` | `toOscalAssessmentResults` (OSCAL 1.1.2 assessment results) |

## Rule profile

A pack is a policy-IR document. Every rule is in phase `observe` and carries
a policy-IR effect: `warn` (inform only) or `mutate` (repairable; needs
literal `fix` values). There is no expression language.

```json
{
  "schemaVersion": "hobo.policy-ir/v1",
  "profile": "hobo.posture/v1",
  "pack": "tls-baseline",
  "observeFields": ["tls.min_version", "public"],
  "rules": [
    {
      "id": "tls-min-version",
      "phase": "observe",
      "effect": "mutate",
      "match": { "kinds": ["http-route"], "classifications": ["pii"] },
      "require": [{ "field": "tls.min_version", "op": "semver-gte", "value": "1.2" }],
      "severity": "high",
      "controls": ["SC-8"],
      "fix": [{ "field": "tls.min_version", "value": "1.3" }]
    }
  ]
}
```

- **Matching:** `match.kinds` and `match.classifications` (empty = any).
- **Operators (fixed):** `eq`, `neq`, `in`, `not-in`, `exists`, `absent`,
  `lt`, `lte`, `gt`, `gte`, `semver-gte`. Operands are canonicalised to
  strings at parse; numeric operators need decimal numbers and `semver-gte` a
  semantic version.
- **`observeFields`** declares every attribute the pack reads. A clause or fix
  naming an undeclared field is refused, so reconcilers report exactly what
  the bound packs need (`observeFields(packs)`), within 16 KiB per resource.
- **Remediation pins:** a pack or rule may set `remediation: "inform-only"`.
  It can never be raised to `enforce` by the Rail binding (the parent).
  Enforcement comes only from a Rail `delivery.posture` binding, and only for
  `mutate` rules.

## Evaluation

`evaluatePosture(rules, observation)` is pure and deterministic (sorted
output, no clock). For each rule × matching resource:

- every `require` clause must hold and no `forbid` clause may hold;
- a clause over an unreported attribute (or a value that does not parse for
  the operator) is `unknown`;
- any failing clause makes the finding `noncompliant`, else any unknown
  makes it `unknown`, else `compliant`;
- a rule that matches nothing yields one `not-applicable` finding.

The summary state is the worst applicable finding. `noncompliantRatio` counts
`unknown` against compliance (fail closed).

## OSCAL

`toOscalAssessmentResults(records)` emits one OSCAL result per compliance
record, one observation per evaluated resource and one finding per cited
control (`not-satisfied` when any citing finding is noncompliant or unknown).
UUIDs are name-based; `last-modified` is the newest record's evaluation time.
`test/posture/posture.test.ts` validates the output against the pinned OSCAL
1.1.2 assessment-results JSON schema
(`test/posture/fixtures/oscal_assessment-results_schema-1.1.2.json`,
sha256 `d033da70154cf6625ae46a746199e88e58f2928b1387dfac051d381b92f41b0d`,
from the usnistgov/OSCAL v1.1.2 release).

## Failure modes

| Code | Meaning | Remediation |
|---|---|---|
| `posture-schema-version`, `posture-profile` | Not a `hobo.policy-ir/v1` posture pack | Fix the document header |
| `posture-phase-invalid` | A rule outside phase `observe` | Set `phase: "observe"` |
| `posture-operator-unknown` | Operator outside the fixed set | Use a listed operator |
| `posture-value-missing`, `posture-values-missing`, `posture-value-unexpected` | Operand shape wrong for the operator | Match the operand to the operator |
| `posture-value-not-numeric`, `posture-value-not-semver` | Operand does not parse | Use a decimal number / semantic version |
| `posture-field-undeclared` | Clause or fix reads a field not in `observeFields` | Declare it, or drop the clause |
| `posture-fix-missing`, `posture-fix-unexpected` | `mutate` without fixes, or `warn` with fixes | Align `effect` and `fix` |
| `posture-remediation-invalid` | A pack or rule tries to pin anything but `inform-only` | Remove it; enforcement comes from the Rail binding |
| `posture-rule-duplicate` | Two rules share an id | Rename one |
| `posture-oscal-empty` | OSCAL export with no records | Export after a posture evaluation |

## Runbook

- **A pack is rejected when a Rail binds it.** The posture service records the
  Camp as `unknown` and emits `hobo.cd.posture.pack_invalid`. Run
  `parsePosturePack` on the document; the error names `code`, `path` and a
  remediation. Fix the pack, approve a new Rail version, promote it.
- **A rule never matches.** It reports `not-applicable`. Check that the
  reconciler reports the resource `kind` and `classification` the rule
  matches, and that every clause field is listed in `observeFields`.
- **Findings stay `unknown`.** The attribute was not reported, or does not
  parse for the operator (for example `TLSv1.2` under `semver-gte`). Report
  the attribute as a bare version, or switch to `eq`/`in`.
- **OSCAL export fails schema validation after an upgrade.** Re-pin the
  schema file and run `pnpm --filter @hobo/policy test -- posture`.
