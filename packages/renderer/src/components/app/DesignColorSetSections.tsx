import { DESIGN_COLOR_GROUPS, type DesignColorGroupKey, type DesignCustomization } from "@buildwarden/shared";
import type { ResolvedCssColor } from "../../lib/design-element-defaults";
import { Button } from "../ui/button";
import { DesignColorField } from "./DesignColorField";
import { SettingsSection } from "./settings-layout";

/** One settings section per color set: code tokens, terminal palette, diff lines, run states, charts. */
export const DesignColorSetSections = ({ customization, resolved, busy, onChange, onClear }: {
  customization: DesignCustomization | undefined;
  /** Colors in effect while a field is empty, by `<set>:<color>`. */
  resolved: Record<string, ResolvedCssColor>;
  busy: boolean;
  onChange: (group: DesignColorGroupKey, color: string, value: string | undefined) => void;
  onClear: (group: DesignColorGroupKey) => void;
}) => (
  <>
    {DESIGN_COLOR_GROUPS.map((group) => {
      const values = customization?.[group.key];
      const setCount = Object.keys(values ?? {}).length;
      return (
        <SettingsSection key={group.key} title={group.label} scope="browser" actions={setCount > 0 ? (
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => onClear(group.key)}>Clear all ({setCount})</Button>
        ) : null}>
          <div className="p-2">
            <p className="px-1 pb-2 text-xs text-[var(--ec-muted)]">{group.description}. A dimmed value is the color in use now.</p>
            <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.colors.map((definition) => (
                <div key={definition.key} className="grid min-w-0 grid-cols-[minmax(4.5rem,0.8fr)_minmax(6.5rem,1fr)] items-center gap-2">
                  <span className="truncate px-1 text-xs text-[var(--ec-text)]">{definition.label}</span>
                  <DesignColorField
                    label={`${group.label}: ${definition.label}`}
                    value={values?.[definition.key]}
                    fallback={resolved[`${group.key}:${definition.key}`]}
                    fallbackNote="default"
                    disabled={busy}
                    onChange={(value) => onChange(group.key, definition.key, value)}
                  />
                </div>
              ))}
            </div>
          </div>
        </SettingsSection>
      );
    })}
  </>
);
