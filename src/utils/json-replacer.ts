/** JSON.stringify replacer: omits object keys whose value is `null`. Array `null` slots are preserved (can't be omitted). */
export function stripNullsReplacer(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}
