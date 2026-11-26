// Constraints for proof.proto. `ProofRoot` is the example-tree root the
// executed examples and notebook run against, so it is pinned to the
// `examples/` prefix: a proof may not point at arbitrary paths on the machine.

package convex_swaghaus_bindle

#root: string & =~"^examples/"

#ProofRoot: {
	// Repo-relative, under examples/, no `..` escape.
	root: #root & =~"^[A-Za-z0-9._][A-Za-z0-9._/-]*$" & !~"(^|/)\\.\\.(/|$)"
}
