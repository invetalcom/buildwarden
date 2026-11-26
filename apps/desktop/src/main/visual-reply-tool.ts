import { VISUAL_REPLY_LIMITS, VISUAL_REPLY_THEME_VARIABLES, VISUAL_REPLY_TOOL_NAME, type RunToolDefinition } from "@buildwarden/shared";

/** The tool an agent calls to show the user a page instead of only text. Runs in the main process. */
export const VISUAL_REPLY_TOOL: RunToolDefinition = {
  name: VISUAL_REPLY_TOOL_NAME,
  description: [
    "Show the user a self-contained HTML page above your written reply: a chart, table, diagram, image collage or mockup.",
    "Use it when the user asks to see something visually, or when a picture explains the answer much better than text. Do not use it for plain prose.",
    "Pass the page as `html`, or write it to a file in the workspace and pass its relative `path` (better for large pages).",
    "The page runs sandboxed and offline: it cannot load anything from the network, so put scripts, styles, SVG and data inline. Local images referenced in the page's markup as <img src=\"relative/path.png\"> or SVG <image href> are embedded; images a script creates are not, so draw them as SVG or inline data instead.",
    `It follows the app's theme through CSS variables: ${VISUAL_REPLY_THEME_VARIABLES.join(", ")}. Keep the page background transparent and the layout responsive; its height adapts to the content.`,
    "After the call, write your normal reply; do not repeat the page's content.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: VISUAL_REPLY_LIMITS.maxTitleLength, description: "Short name shown above the page." },
      html: { type: "string", description: "The complete page. Leave out when `path` is given." },
      path: { type: "string", description: "Workspace-relative path of an .html file holding the page. Leave out when `html` is given." },
    },
  },
};
