import type { SupportedIdeKind } from "@easycode/shared";

const defaultIconClass = "h-8 w-8 shrink-0";

/** Stylized marks inspired by common IDE branding (not official logos). */
export const IdeBrandIcon = ({ kind, className }: { kind: SupportedIdeKind; className?: string }) => {
  const cn = className ?? defaultIconClass;

  if (kind === "vscode") {
    return (
      <svg className={cn} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path
          d="M4 24L18 4l6 4v20l-6 4L4 8v16z"
          fill="url(#vscode-a)"
          opacity={0.95}
        />
        <path d="M18 4l10 8-10 6V4z" fill="url(#vscode-b)" />
        <defs>
          <linearGradient id="vscode-a" x1="4" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
            <stop stopColor="#3B9FE8" />
            <stop offset="1" stopColor="#1E6BB8" />
          </linearGradient>
          <linearGradient id="vscode-b" x1="18" y1="4" x2="30" y2="14" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6ECBFF" />
            <stop offset="1" stopColor="#2B8FD9" />
          </linearGradient>
        </defs>
      </svg>
    );
  }

  if (kind === "cursor") {
    return (
      <svg className={cn} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <rect x="3" y="3" width="26" height="26" rx="7" fill="#1a1a1e" stroke="#3f3f46" strokeWidth="1.5" />
        <path
          d="M11 10l10 6-10 6V10z"
          fill="#e4e4e7"
        />
        <path
          d="M19 8l6 4-6 4V8z"
          fill="#a1a1aa"
          opacity={0.85}
        />
      </svg>
    );
  }

  return (
    <svg className={cn} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="4" y="4" width="24" height="24" rx="4" fill="#0D0D0D" transform="rotate(-12 16 16)" />
      <rect x="7" y="9" width="18" height="14" rx="2" fill="#F97316" transform="rotate(-12 16 16)" />
      <path
        d="M10 20h8M10 16h12"
        stroke="#0D0D0D"
        strokeWidth="1.5"
        strokeLinecap="round"
        transform="rotate(-12 16 16)"
      />
    </svg>
  );
};
