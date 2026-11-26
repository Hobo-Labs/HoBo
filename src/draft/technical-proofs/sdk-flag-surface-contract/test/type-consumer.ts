import {
  createFlagSurfaceEventLog,
  createSdkFlagContract,
  createSdkFlagSurface,
} from "@hobo/draft-sdk-flag-surface-contract";

async function assertFlagTypes() {
  const contract = createSdkFlagContract();
  const enabled = contract.flag.boolean("new-checkout", { default: false });
  const label = contract.flag.string("checkout-label", { default: "control" });
  const surface = createSdkFlagSurface({
    eventLog: createFlagSurfaceEventLog([
      { seq: 1, event: enabled.event },
      { seq: 2, event: label.event },
    ]),
  });

  const enabledValue: boolean = await surface.ctx.flags.eval(enabled);
  const labelValue: string = await surface.ctx.flags.eval(label);
  const hookValue: boolean = surface.useFlag(enabled).value();

  // @ts-expect-error boolean flags do not evaluate to strings.
  const invalidString: string = await surface.ctx.flags.eval(enabled);

  // @ts-expect-error boolean flag defaults must be booleans.
  contract.flag.boolean("bad-default", { default: "false" });

  void enabledValue;
  void labelValue;
  void hookValue;
  void invalidString;
}

void assertFlagTypes;
