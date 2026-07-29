export type ClassValue = string | false | null | undefined;

/**
 * Minimal class joiner. The mobile UI owns every class string it emits, so it does not need
 * `tailwind-merge`'s conflict resolution — and skipping it keeps the mobile chunk smaller.
 */
export const cn = (...values: ClassValue[]): string => values.filter(Boolean).join(" ");
