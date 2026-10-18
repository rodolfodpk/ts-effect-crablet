// Compile-time tests (never executed): a model accepts only events that carry the tag it binds through. An event that did not would match
// nothing, so the fold would miss it and the boundary would not see a concurrent change to it.
import * as Schema from "effect/Schema";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";

const Opened = defineEvent("MT_Opened", { schema: Schema.Struct({ accountId: Schema.String }), tags: (d) => ({ account_id: d.accountId }) });
const Moved = defineEvent("MT_Moved", {
  schema: Schema.Struct({ fromId: Schema.String, toId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ from_id: d.fromId, to_id: d.toId })
});
const Noted = defineEvent("MT_Noted", { schema: Schema.Struct({ text: Schema.String }), tags: () => ({}) });

// Accepted: the events carry the tag, through `by` or through the keys `opts.by` names; the handlers' parameters stay inferred.
export const Account = defineModel({ by: "account_id", initial: () => ({ open: false, balance: 0 }) })
  .lifecycle(Opened, (s) => ({ ...s, open: true }))
  .on(Moved, (s, d) => ({ ...s, balance: s.balance + d.amount }), { by: ["from_id", "to_id"] });

// A typo in `by`.
// @ts-expect-error this event does not carry the tag "acount_id" the model binds through
defineModel({ by: "acount_id", initial: () => 0 }).on(Opened, (n) => n);

// An event without the model's tag, through `.on` and through `.lifecycle`.
// @ts-expect-error this event does not carry the tag "account_id" the model binds through
defineModel({ by: "account_id", initial: () => 0 }).on(Noted, (n) => n);
// @ts-expect-error this event does not carry the tag "account_id" the model binds through
defineModel({ by: "account_id", initial: () => 0 }).lifecycle(Moved, (n) => n);

// `opts.by` naming a tag the event does not carry.
// @ts-expect-error this event does not carry the tag "via_id" the model binds through
defineModel({ by: "account_id", initial: () => 0 }).on(Moved, (n) => n, { by: ["from_id", "via_id"] });
