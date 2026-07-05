const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// Table/column names here come from trusted, compile-time TS constants (ProgressTableSpec, module
// names), never from request input - this is a defensive guard against accidental typos/injection
// via sql.unsafe string interpolation, not a security boundary against untrusted input.
export function assertSafeIdentifier(identifier: string): void {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: "${identifier}"`);
  }
}
