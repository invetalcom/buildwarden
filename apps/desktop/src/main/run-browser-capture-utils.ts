import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { RunBrowserElementCapture, RunBrowserLocatorSegment } from "@buildwarden/shared";

const SENSITIVE_NAME = /token|secret|auth|key|session|password/i;

export type CdpValueResult<T> = { result?: { value?: T; objectId?: string } };
export type CdpResolveNodeResult = { object?: { objectId?: string } };
export type CdpAxValue = { value?: string };
export type CdpAxNode = { role?: CdpAxValue; name?: CdpAxValue };

export const PAGE_COLLECTOR_SOURCE = String.raw`function (finderSource) {
  if (!globalThis.__buildwardenFinder) {
    (0, eval)(finderSource);
  }
  const find = globalThis.__buildwardenFinder;
  const sensitive = /token|secret|auth|key|session|password/i;
  const volatile = (value) => {
    const text = String(value || "");
    return /^\d/.test(text) || /[a-f0-9]{12,}/i.test(text) || /(?:^|[-_])(?:css|sc|ng|jsx|ember|chakra|mui)[-_]?[a-z]*\d{3,}/i.test(text);
  };
  const safeUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      parsed.username = "";
      parsed.password = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (sensitive.test(key)) parsed.searchParams.set(key, "[REDACTED]");
      }
      return parsed.toString();
    } catch {
      return String(value || "").slice(0, 2048);
    }
  };
  const options = (root) => ({
    root,
    timeoutMs: 250,
    idName: (value) => !volatile(value),
    className: (value) => !volatile(value),
    tagName: () => true,
    attr: (name, value) => !sensitive.test(name) && !/^on/i.test(name) && !volatile(value) && /^(?:role|name|aria-|data-)/i.test(name),
  });
  const structural = (element, root) => {
    const parts = [];
    let cursor = element;
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE && cursor !== root) {
      const tag = cursor.tagName.toLowerCase();
      const siblings = cursor.parentElement ? [...cursor.parentElement.children].filter((item) => item.tagName === cursor.tagName) : [];
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + String(siblings.indexOf(cursor) + 1) + ")" : tag);
      cursor = cursor.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  };
  const selectorFor = (element, root) => {
    try {
      return find(element, options(root));
    } catch {
      return structural(element, root);
    }
  };
  const locatorSegments = [];
  let current = this;
  let selected = true;
  while (current) {
    const root = current.getRootNode();
    locatorSegments.unshift({ kind: selected ? "element" : "shadow", selector: selectorFor(current, root) });
    if (!(root instanceof ShadowRoot)) break;
    current = root.host;
    selected = false;
  }
  try {
    let currentWindow = this.ownerDocument.defaultView;
    while (currentWindow && currentWindow.frameElement) {
      const frame = currentWindow.frameElement;
      locatorSegments.unshift({ kind: "frame", selector: selectorFor(frame, frame.ownerDocument) });
      currentWindow = currentWindow.parent;
    }
  } catch {
    // Cross-origin frame targets are prefixed by the host from CDP target data.
  }
  const controlIsSensitive = (element) => {
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    if (["password", "hidden"].includes(type)) return true;
    const semanticValues = [
      type,
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("autocomplete"),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
    ];
    for (const label of element.labels || []) semanticValues.push(label.textContent);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) semanticValues.push(element.ownerDocument.getElementById(id)?.textContent);
    }
    return semanticValues.some((value) => sensitive.test(String(value || "")));
  };
  const selectedControlIsSensitive = controlIsSensitive(this);
  const sanitizeElement = (element) => {
    const sensitiveControl = controlIsSensitive(element);
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      if (/^on/i.test(name)) {
        element.removeAttribute(name);
      } else if (sensitive.test(name) || (sensitiveControl && name.toLowerCase() === "value")) {
        element.setAttribute(name, "[REDACTED]");
      } else if (/^(?:href|src|action|formaction)$/i.test(name)) {
        element.setAttribute(name, safeUrl(attribute.value));
      }
    }
    if (sensitiveControl && element instanceof HTMLTextAreaElement) {
      element.textContent = "[REDACTED]";
    }
  };
  const clone = this.cloneNode(true);
  const clonedElements = [clone, ...clone.querySelectorAll("*")];
  for (const element of clonedElements) {
    if (/^(?:script|style|noscript)$/i.test(element.tagName)) {
      element.remove();
      continue;
    }
    sanitizeElement(element);
  }
  const attributes = {};
  for (const attribute of [...this.attributes].slice(0, 100)) {
    const name = attribute.name;
    const redactValue = sensitive.test(name) || (selectedControlIsSensitive && name.toLowerCase() === "value");
    attributes[name] = redactValue ? "[REDACTED]" : /^(?:href|src|action|formaction)$/i.test(name) ? safeUrl(attribute.value) : attribute.value.slice(0, 1024);
  }
  const style = getComputedStyle(this);
  const styleNames = ["display", "position", "visibility", "opacity", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "width", "height", "margin", "padding", "border", "border-radius", "overflow", "z-index"];
  const computedStyles = {};
  for (const name of styleNames) computedStyles[name] = style.getPropertyValue(name);
  const ancestry = [];
  let ancestor = this.parentElement;
  while (ancestor && ancestry.length < 8) {
    const label = ancestor.tagName.toLowerCase() + (ancestor.id && !volatile(ancestor.id) ? "#" + ancestor.id : "") + [...ancestor.classList].filter((name) => !volatile(name)).slice(0, 3).map((name) => "." + name).join("");
    ancestry.unshift(label);
    ancestor = ancestor.parentElement;
  }
  const frameworkHints = [];
  const angularAttribute = [...this.attributes].find((attribute) => /^_ng(?:content|host)-|^ng-reflect-/i.test(attribute.name));
  const angularRoot = this.closest("[ng-version]");
  if (angularAttribute || angularRoot || globalThis.ng) {
    let componentName = this.tagName.includes("-") ? this.tagName.toLowerCase() : undefined;
    try {
      componentName = globalThis.ng && globalThis.ng.getComponent ? globalThis.ng.getComponent(this)?.constructor?.name || componentName : componentName;
    } catch {}
    frameworkHints.push({ framework: "angular", name: componentName, details: [angularAttribute?.name, angularRoot?.getAttribute("ng-version") ? "Angular " + angularRoot.getAttribute("ng-version") : undefined].filter(Boolean) });
  }
  const wpClass = [...this.classList].find((name) => name.startsWith("wp-block-"));
  if (wpClass || document.body?.classList.contains("wp-admin") || document.documentElement.classList.contains("wp-toolbar")) {
    frameworkHints.push({ framework: "wordpress", name: wpClass?.replace(/^wp-block-/, ""), details: [document.body?.classList.contains("wp-admin") ? "WordPress admin" : "WordPress page"].filter(Boolean) });
  }
  const rect = this.getBoundingClientRect();
  let viewportX = rect.x;
  let viewportY = rect.y;
  try {
    let currentWindow = this.ownerDocument.defaultView;
    while (currentWindow && currentWindow.frameElement) {
      const frameRect = currentWindow.frameElement.getBoundingClientRect();
      viewportX += frameRect.x;
      viewportY += frameRect.y;
      currentWindow = currentWindow.parent;
    }
  } catch {
    // Cross-origin frame targets are cropped conservatively by the host.
  }
  return {
    locatorSegments,
    fallback: structural(this, this.getRootNode()),
    tagName: this.tagName.toLowerCase(),
    visibleText: selectedControlIsSensitive
      ? "[REDACTED]"
      : String(this.innerText || this.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    sanitizedHtml: String(clone.outerHTML || "").slice(0, 12000),
    attributes,
    computedStyles,
    ancestry,
    frameworkHints,
    bounds: { x: viewportX, y: viewportY, width: rect.width, height: rect.height },
    url: safeUrl(location.href),
    title: document.title.slice(0, 1000),
  };
}`;

let cachedFinderSource: string | null = null;

export const getFinderSource = (): string => {
  if (cachedFinderSource) return cachedFinderSource;
  const modulePath = createRequire(import.meta.url).resolve("@medv/finder");
  cachedFinderSource = `${readFileSync(modulePath, "utf8").replace(/(^|\n)export\s+/g, "$1")}\nglobalThis.__buildwardenFinder = finder;`;
  return cachedFinderSource;
};

export const isVolatileSelectorToken = (value: string): boolean =>
  /^\d/.test(value) || /[a-f0-9]{12,}/i.test(value) || /(?:^|[-_])(?:css|sc|ng|jsx|ember|chakra|mui)[-_]?[a-z]*\d{3,}/i.test(value);

export const sanitizeRunBrowserUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(name)) url.searchParams.set(name, "[REDACTED]");
    }
    if (url.hash.includes("=")) {
      const hash = new URLSearchParams(url.hash.slice(1));
      for (const name of [...hash.keys()]) {
        if (SENSITIVE_NAME.test(name)) hash.set(name, "[REDACTED]");
      }
      url.hash = hash.toString();
    }
    return url.toString();
  } catch {
    return "about:blank";
  }
};

export const renderElementMarkdown = (capture: Omit<RunBrowserElementCapture, "contextAttachment" | "screenshotAttachment">): string => {
  const lines = [
    `# Browser element #${String(capture.annotationNumber)}`,
    "",
    `- URL: ${capture.url}`,
    `- Page title: ${capture.pageTitle || "(untitled)"}`,
    `- Selector: \`${capture.locator.selector}\``,
    `- Element: \`<${capture.tagName}>\``,
    `- Accessible role: ${capture.accessibleRole || "(none)"}`,
    `- Accessible name: ${capture.accessibleName || "(none)"}`,
    `- Bounds: x=${String(Math.round(capture.bounds.x))}, y=${String(Math.round(capture.bounds.y))}, width=${String(Math.round(capture.bounds.width))}, height=${String(Math.round(capture.bounds.height))}`,
    "",
    "## User note",
    "",
    capture.comment || "(none)",
    "",
    "## Visible text",
    "",
    capture.visibleText || "(none)",
    "",
    "## Sanitized HTML",
    "",
    "```html",
    capture.sanitizedHtml,
    "```",
    "",
    "## Attributes",
    "",
    "```json",
    JSON.stringify(capture.attributes, null, 2),
    "```",
    "",
    "## Computed styles",
    "",
    "```json",
    JSON.stringify(capture.computedStyles, null, 2),
    "```",
  ];
  if (capture.ancestry.length > 0) lines.push("", "## Ancestry", "", capture.ancestry.join(" > "));
  if (capture.frameworkHints.length > 0) lines.push("", "## Framework hints", "", JSON.stringify(capture.frameworkHints, null, 2));
  return lines.join("\n");
};

export const selectorFromSegments = (segments: RunBrowserLocatorSegment[]): string =>
  segments.map((segment) => segment.selector).join(" >>> ");

