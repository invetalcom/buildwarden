/**
 * Runs against the selected DOM node through CDP. The UI lives in a closed
 * shadow root so inspected pages cannot accidentally style or intercept it.
 */
export const SHOW_RUN_BROWSER_ANNOTATION_EDITOR_SOURCE = String.raw`function (bindingName, token, markerNumber) {
  const selectedElement = this;
  const selectedWindow = selectedElement.ownerDocument && selectedElement.ownerDocument.defaultView;
  if (!selectedWindow) return false;

  const managerKey = "__buildwardenAnnotations";
  let manager = selectedWindow[managerKey];
  if (!manager) {
    const document = selectedWindow.document;
    const host = document.createElement("div");
    host.setAttribute("data-buildwarden-annotations", "");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;visibility:visible";
    const root = host.attachShadow({ mode: "closed" });
    (document.documentElement || document.body).appendChild(host);

    const createBox = (kind) => {
      const element = document.createElement("div");
      element.dataset.kind = kind;
      if (kind === "outline") {
        element.style.cssText = "all:initial;position:fixed;box-sizing:border-box;border:2px solid #38bdf8;border-radius:5px;background:rgba(56,189,248,.10);box-shadow:0 0 0 1px rgba(15,23,42,.55);pointer-events:none;transition:opacity 120ms ease";
      } else {
        element.style.cssText = "all:initial;position:fixed;box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border:1px solid rgba(255,255,255,.82);border-radius:999px;background:#0284c7;color:#fff;font:700 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;box-shadow:0 2px 8px rgba(15,23,42,.45);pointer-events:none";
      }
      root.appendChild(element);
      return element;
    };

    const removeVisual = (entry) => {
      entry.outline.remove();
      entry.badge.remove();
      if (entry.panel) entry.panel.remove();
    };

    const entries = new Map();
    let current = null;
    let animationFrame = 0;

    const positionEntry = (entry) => {
      if (!entry.element.isConnected) {
        entry.outline.style.display = "none";
        entry.badge.style.display = "none";
        if (entry.panel) entry.panel.style.display = "none";
        return;
      }
      const rect = entry.element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= selectedWindow.innerHeight && rect.left <= selectedWindow.innerWidth;
      entry.outline.style.display = visible ? "block" : "none";
      entry.badge.style.display = visible ? "flex" : "none";
      if (!visible) {
        if (entry.panel) entry.panel.style.display = "none";
        return;
      }
      entry.outline.style.left = rect.left + "px";
      entry.outline.style.top = rect.top + "px";
      entry.outline.style.width = Math.max(1, rect.width) + "px";
      entry.outline.style.height = Math.max(1, rect.height) + "px";
      entry.badge.style.left = Math.max(4, Math.min(selectedWindow.innerWidth - 24, rect.left - 8)) + "px";
      entry.badge.style.top = Math.max(4, Math.min(selectedWindow.innerHeight - 24, rect.top - 10)) + "px";
      if (entry.panel) {
        entry.panel.style.display = "block";
        const panelWidth = Math.min(296, selectedWindow.innerWidth - 16);
        entry.panel.style.width = panelWidth + "px";
        const panelHeight = entry.panel.offsetHeight || 176;
        const maxLeft = Math.max(8, selectedWindow.innerWidth - panelWidth - 8);
        const left = Math.max(8, Math.min(maxLeft, rect.left));
        let top = rect.bottom + 8;
        if (top + panelHeight > selectedWindow.innerHeight - 8) top = rect.top - panelHeight - 8;
        entry.panel.style.left = left + "px";
        entry.panel.style.top = Math.max(8, Math.min(selectedWindow.innerHeight - panelHeight - 8, top)) + "px";
      }
    };

    const scheduleLayout = () => {
      if (animationFrame) return;
      animationFrame = selectedWindow.requestAnimationFrame(() => {
        animationFrame = 0;
        for (const entry of entries.values()) positionEntry(entry);
        if (current) positionEntry(current);
      });
    };
    selectedWindow.addEventListener("scroll", scheduleLayout, true);
    selectedWindow.addEventListener("resize", scheduleLayout);

    const send = (entry, type, comment) => {
      const binding = selectedWindow[entry.bindingName];
      if (typeof binding !== "function") return false;
      binding(JSON.stringify({ type, token: entry.token, comment: String(comment || "").slice(0, 1000) }));
      return true;
    };

    manager = {
      open(element, nextBindingName, nextToken, nextNumber) {
        if (current) removeVisual(current);
        const outline = createBox("outline");
        const badge = createBox("badge");
        badge.textContent = String(nextNumber);

        const panel = document.createElement("div");
        panel.style.cssText = "all:initial;position:fixed;box-sizing:border-box;display:block;padding:10px;border:1px solid rgba(56,189,248,.72);border-radius:9px;background:#0f172a;color:#e2e8f0;box-shadow:0 16px 38px rgba(2,6,23,.42);font:12px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;pointer-events:auto";

        const header = document.createElement("div");
        header.style.cssText = "all:initial;display:flex;align-items:center;gap:7px;margin:0 0 7px;color:#e2e8f0;font:600 12px/1.3 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif";
        const number = document.createElement("span");
        number.style.cssText = "all:initial;display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:#0284c7;color:#fff;font:700 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif";
        number.textContent = String(nextNumber);
        const label = document.createElement("span");
        label.style.cssText = "all:initial;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2e8f0;font:600 12px/1.3 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif";
        const accessibleLabel = element.getAttribute("aria-label") || element.getAttribute("title") || String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
        label.textContent = accessibleLabel || "<" + element.tagName.toLowerCase() + ">";
        header.append(number, label);

        const input = document.createElement("textarea");
        input.maxLength = 1000;
        input.rows = 3;
        input.placeholder = "What should the agent notice or change?";
        input.setAttribute("aria-label", "Browser element note");
        input.style.cssText = "all:initial;box-sizing:border-box;display:block;width:100%;min-height:62px;max-height:130px;resize:vertical;padding:7px 8px;border:1px solid #334155;border-radius:6px;background:#020617;color:#f8fafc;caret-color:#38bdf8;font:12px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;white-space:pre-wrap";

        const footer = document.createElement("div");
        footer.style.cssText = "all:initial;display:flex;align-items:center;gap:6px;margin-top:8px";
        const status = document.createElement("span");
        status.style.cssText = "all:initial;display:block;min-width:0;flex:1;color:#94a3b8;font:10px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif";
        status.textContent = "Ctrl/⌘ + Enter to attach";

        const button = (text, primary) => {
          const result = document.createElement("button");
          result.type = "button";
          result.textContent = text;
          result.style.cssText = "all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:27px;padding:0 9px;border:1px solid " + (primary ? "#38bdf8" : "#475569") + ";border-radius:6px;background:" + (primary ? "#0284c7" : "#1e293b") + ";color:#fff;font:600 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer";
          return result;
        };
        const cancelButton = button("Cancel", false);
        const attachButton = button("Attach", true);
        footer.append(status, cancelButton, attachButton);
        panel.append(header, input, footer);
        root.appendChild(panel);

        current = { element, bindingName: nextBindingName, token: nextToken, number: nextNumber, outline, badge, panel, input, status, attachButton, cancelButton, busy: false };
        const commit = () => {
          if (!current || current.token !== nextToken || current.busy) return;
          current.busy = true;
          current.attachButton.disabled = true;
          current.cancelButton.disabled = true;
          current.status.textContent = "Capturing…";
          if (!send(current, "commit", input.value)) {
            current.busy = false;
            current.attachButton.disabled = false;
            current.cancelButton.disabled = false;
            current.status.textContent = "Could not reach BuildWarden";
          }
        };
        attachButton.addEventListener("click", commit);
        cancelButton.addEventListener("click", () => current && !current.busy && send(current, "resume", ""));
        input.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (current && !current.busy) send(current, "resume", "");
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit();
          }
        });
        host.style.visibility = "visible";
        scheduleLayout();
        selectedWindow.setTimeout(() => input.focus({ preventScroll: true }), 0);
      },
      prepare(nextToken) {
        if (!current || current.token !== nextToken) return;
        host.style.visibility = "hidden";
      },
      accept(nextToken, nextNumber) {
        if (!current || current.token !== nextToken) return;
        current.panel.remove();
        current.panel = null;
        current.outline.style.opacity = ".48";
        current.badge.textContent = String(nextNumber);
        entries.set(nextToken, current);
        current = null;
        host.style.visibility = "visible";
        scheduleLayout();
      },
      reject(nextToken, message) {
        if (!current || current.token !== nextToken) return;
        host.style.visibility = "visible";
        current.busy = false;
        current.attachButton.disabled = false;
        current.cancelButton.disabled = false;
        current.status.textContent = String(message || "Could not capture this element").slice(0, 120);
        current.panel.style.display = "block";
        scheduleLayout();
        current.input.focus({ preventScroll: true });
      },
      dismiss(nextToken) {
        if (!current || current.token !== nextToken) return;
        removeVisual(current);
        current = null;
        host.style.visibility = "visible";
      },
      remove(nextToken) {
        if (current && current.token === nextToken) {
          removeVisual(current);
          current = null;
        }
        const entry = entries.get(nextToken);
        if (entry) removeVisual(entry);
        entries.delete(nextToken);
      },
      clear() {
        if (current) removeVisual(current);
        current = null;
        for (const entry of entries.values()) removeVisual(entry);
        entries.clear();
      },
    };
    selectedWindow[managerKey] = manager;
  }

  manager.open(selectedElement, bindingName, token, markerNumber);
  return true;
}`;

export const CALL_RUN_BROWSER_ANNOTATION_MANAGER_SOURCE = String.raw`function (method, args) {
  const selectedWindow = this.ownerDocument && this.ownerDocument.defaultView;
  const manager = selectedWindow && selectedWindow.__buildwardenAnnotations;
  if (!manager || typeof manager[method] !== "function") return false;
  manager[method](...(Array.isArray(args) ? args : []));
  return true;
}`;
