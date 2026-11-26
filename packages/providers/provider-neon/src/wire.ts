/**
 * How a domain type is built on top of a generated protobuf message.
 *
 * The records this package reasons about are declared in
 * `data-models/provider_neon.proto` and generated into
 * `src/_generated/provider_neon_pb.ts`. A hand-written parallel interface
 * would drift from them silently, so every domain type is expressed as a
 * {@link DomainView} of its generated wire message: the fields it does not
 * refine come straight from the generated type, and the ones it does refine
 * are named explicitly.
 *
 * The refinement map is key-checked against the wire message, so renaming a
 * proto field breaks the build here instead of at run time.
 */
import type { Message } from "@bufbuild/protobuf";

/** A generated message without its runtime envelope. */
export type WireFields<TWire extends Message> = Omit<
	TWire,
	"$typeName" | "$unknown"
>;

/**
 * A parse-don't-validate view over the generated wire message `TWire`.
 *
 * @typeParam TRefined - fields this view states more precisely than proto3
 * can: literal unions, branded locators, required-where-the-wire-is-optional.
 * Every key must exist on `TWire`.
 * @typeParam TDropped - wire fields this view deliberately does not carry.
 */
export type DomainView<
	TWire extends Message,
	TRefined extends {
		[K in keyof TRefined]: K extends keyof WireFields<TWire> ? unknown : never;
	},
	TDropped extends keyof WireFields<TWire> = never,
> = Readonly<Omit<WireFields<TWire>, keyof TRefined | TDropped>> & {
	readonly [K in keyof TRefined]: TRefined[K];
};
