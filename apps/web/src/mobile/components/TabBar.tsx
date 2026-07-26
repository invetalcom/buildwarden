import { Home, ListTree, MessagesSquare, MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn";
import type { MobileTab } from "../nav/mobile-router";

const TABS: { id: MobileTab; label: string; Icon: typeof Home }[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "runs", label: "Runs", Icon: ListTree },
  { id: "chats", label: "Chats", Icon: MessagesSquare },
  { id: "more", label: "More", Icon: MoreHorizontal },
];

export const TabBar = ({
  active,
  onSelect,
  badges,
}: {
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
  badges?: Partial<Record<MobileTab, number>>;
}) => (
  <nav
    className="m-safe-bottom shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-sidebar)]"
    style={{ paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
  >
    <div className="flex h-[var(--m-tabbar-height)] items-stretch">
      {TABS.map(({ id, label, Icon }) => {
        const isActive = id === active;
        const badge = badges?.[id] ?? 0;
        return (
          <button
            key={id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition",
              isActive ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]",
            )}
          >
            <span className="relative">
              <Icon className="size-[22px]" strokeWidth={isActive ? 2.4 : 1.9} />
              {badge > 0 ? (
                <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-[var(--ec-danger)] px-1 text-[10px] font-semibold leading-4 text-white">
                  {badge > 9 ? "9+" : badge}
                </span>
              ) : null}
            </span>
            <span className="text-[10px] font-medium leading-3">{label}</span>
          </button>
        );
      })}
    </div>
  </nav>
);
