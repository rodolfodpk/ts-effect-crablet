// What an automation decides to do about one event: run its command with some input, or nothing.
//
// A plain data union - the command itself is NOT carried on the decision. AutomationHandler.ts binds
// one defined command `Command<T, HE>` once, at construction (there is no runtime command lookup;
// see ADR-0008), so a decision only needs the INPUT for that command.
export interface ExecuteCommand<T> {
  readonly _tag: "ExecuteCommand";
  readonly input: T;
}

export const executeCommand = <T>(input: T): ExecuteCommand<T> => ({ _tag: "ExecuteCommand", input });

export interface NoOp {
  readonly _tag: "NoOp";
}

export const noOp = (): NoOp => ({ _tag: "NoOp" });

export type AutomationDecision<T> = ExecuteCommand<T> | NoOp;
