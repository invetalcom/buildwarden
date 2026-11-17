import { createContext } from "react";

/** Scoped to one transcript: citations never navigate into another run or chat. */
export const ResponseCitationContext = createContext<((stepId: string) => boolean) | null>(null);
