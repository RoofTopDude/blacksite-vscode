type ClassNameValue = string | false | null | undefined;

/** Minimal class joiner (zero-dep, mirrors chrome-extension-v3/src/lib/utils.ts). */
export function cn(...values: ClassNameValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}
