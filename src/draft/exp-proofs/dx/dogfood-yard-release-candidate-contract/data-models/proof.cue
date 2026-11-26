// Constraints for proof.proto. The definition is *named* `#ProofIdentity`
// because that is the message `proof.proto` declares: an anonymous record
// beside a proto type constrains nothing that the guard — or a reader — can
// tie back to it. `convex-swaghaus-bindle` already names its definition after
// its message, and constrains it rather than restating the proto's own types.
//
// `slug` gains `!=""`, and that is a real refusal, not a rename. The previous
// `slug: string` restated proto3's declared type and rejected nothing, so a
// proof identifying itself with the empty string validated. Measured on a
// reduced case with cue v0.14.0, old form against new: `slug: ""` goes 0 → 1,
// and every other case is unchanged — a well-formed record stays 0, `slug: 7`
// stays 1, `layer: "ux"` stays 1. That single case is the whole delta.
//
// The definition is then embedded at top level, so the file still presents the
// same concrete `slug`/`layer` record to anything that reads it as data.

package proof

#ProofIdentity: {
	slug:  string & !=""
	layer: "exp"
}

#ProofIdentity
