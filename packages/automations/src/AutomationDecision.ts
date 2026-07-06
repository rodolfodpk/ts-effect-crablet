// Port of com.crablet.automations.AutomationDecision - a sealed interface in Java
// (ExecuteCommand(Object command) / NoOp(String reason)), a discriminated union here.
//
// Deliberately narrower than Java's: the command's handler is NOT carried on the decision.
// Java resolves the right CommandHandler by runtime type lookup; this repo's CommandExecutor has
// no such lookup (see ADR-0008 - every call site passes the handler explicitly), so
// AutomationHandler.ts binds one CommandHandler<T, HE> once, at construction, instead. That keeps
// this type a plain data union, with no function value inside it.
export interface ExecuteCommand<T> {
  readonly _tag: "ExecuteCommand";
  readonly command: T;
}

export const executeCommand = <T>(command: T): ExecuteCommand<T> => ({ _tag: "ExecuteCommand", command });

export interface NoOp {
  readonly _tag: "NoOp";
}

export const noOp = (): NoOp => ({ _tag: "NoOp" });

export type AutomationDecision<T> = ExecuteCommand<T> | NoOp;
