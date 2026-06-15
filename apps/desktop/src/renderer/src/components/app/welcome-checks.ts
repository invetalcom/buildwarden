import type { AppSnapshot } from "@buildwarden/shared";

export type WelcomeCheckId = "provider-models" | "project";

export type WelcomeCheckDefinition = {
  id: WelcomeCheckId;
  title: string;
  navLabel: string;
  description: string;
  satisfiedLabel: string;
};

export const WELCOME_CHECK_DEFINITIONS = [
  {
    id: "provider-models",
    title: "Connect the agent engine",
    navLabel: "Provider & model",
    description: "Add one provider account and one model so runs and chats know what brain to use.",
    satisfiedLabel: "Engine connected. Provider and model are ready.",
  },
  {
    id: "project",
    title: "Pick a workspace folder",
    navLabel: "Project",
    description: "Choose the folder where BuildWarden should roll up its sleeves.",
    satisfiedLabel: "Project added. The workspace is ready.",
  },
] as const satisfies readonly WelcomeCheckDefinition[];

export const isWelcomeCheckSatisfied = (checkId: WelcomeCheckId, snapshot: AppSnapshot): boolean => {
  switch (checkId) {
    case "provider-models":
      return snapshot.providerAccounts.length > 0 && snapshot.models.length > 0;
    case "project":
      return snapshot.projects.length > 0;
  }
};

export const getSatisfiedWelcomeCheckIds = (snapshot: AppSnapshot): WelcomeCheckId[] =>
  WELCOME_CHECK_DEFINITIONS.filter((check) => isWelcomeCheckSatisfied(check.id, snapshot)).map((check) => check.id);

export const orderWelcomeCheckIds = (ids: Iterable<string>): WelcomeCheckId[] => {
  const set = new Set(ids);
  return WELCOME_CHECK_DEFINITIONS.map((check) => check.id).filter((id) => set.has(id));
};
