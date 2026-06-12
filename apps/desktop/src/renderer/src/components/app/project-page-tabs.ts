export type ProjectPageTab =
  | "overview"
  | "lab"
  | "branches"
  | "tasks"
  | "reviews"
  | "graphs"
  | "ai-insights-history"
  | "for-later"
  | "settings";

export const PROJECT_PAGE_LABELS: Record<ProjectPageTab, string> = {
  overview: "Agent Runs",
  lab: "Project Lab",
  branches: "Branches",
  tasks: "Task Board",
  reviews: "MR Review",
  graphs: "Graphs",
  "ai-insights-history": "AI Insights",
  "for-later": "For Later",
  settings: "Project Settings",
};
