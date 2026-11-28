import type { Message } from "@bufbuild/protobuf";

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
