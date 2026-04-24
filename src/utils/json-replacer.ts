/**
 * JSON.stringify replacer that omits keys whose value is `null`.
 *
 * Returning `undefined` from a replacer causes JSON.stringify to drop the key
 * entirely. The replacer is invoked recursively by the engine at every depth,
 * so nested nulls are stripped automatically.
 *
 * Caveat: if `null` ever appears as an array item, this replacer would cause
 * JSON.stringify to emit the literal string "null" for that slot (array items
 * can't be omitted). Our response shapes only use `null` on object properties,
 * not array items, so this caveat does not apply in practice.
 */
export function stripNullsReplacer(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}
