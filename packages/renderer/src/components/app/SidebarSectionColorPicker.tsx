import { isRunSectionColor } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { ColorInput } from "../ui/color-input";

const PRESETS = [
  { name: "Blue", color: "#60a5fa" }, { name: "Purple", color: "#a78bfa" },
  { name: "Pink", color: "#f472b6" }, { name: "Red", color: "#f87171" },
  { name: "Orange", color: "#fb923c" }, { name: "Yellow", color: "#facc15" },
  { name: "Green", color: "#4ade80" }, { name: "Teal", color: "#2dd4bf" },
  { name: "Gray", color: "#94a3b8" },
];

export const SidebarSectionColorPicker = ({ value, onChange, disabled }: {
  value: string; onChange: (color: string) => void; disabled: boolean;
}) => <fieldset disabled={disabled} className="space-y-2">
  <legend className="mb-2 text-xs">Section color</legend>
  <div className="flex flex-wrap gap-1" role="group" aria-label="Preset section colors">
    {PRESETS.map(({ name, color }) => <button key={color} type="button" title={name} aria-label={`${name} section color`}
      aria-pressed={value.toLowerCase() === color} onClick={() => onChange(color)}
      className={cn("flex size-7 items-center justify-center rounded-md border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] disabled:opacity-50",
        value.toLowerCase() === color ? "border-[var(--ec-accent)] bg-[var(--ec-accent-soft)]" : "hover:bg-[var(--ec-hover)]")}>
      <span className="size-4 rounded-full ring-1 ring-inset ring-black/15" style={{ backgroundColor: color }} />
    </button>)}
  </div>
  <ColorInput ariaLabel="Custom section color" value={value} onValueChange={onChange} disabled={disabled} />
  {!isRunSectionColor(value) && <p className="text-xs text-[var(--ec-danger)]" role="alert">Enter a six-digit hex color, such as #60a5fa.</p>}
</fieldset>;
