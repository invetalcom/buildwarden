import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)] hover:bg-[var(--ec-accent-strong)]",
        ghost: "bg-transparent text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
        secondary: "bg-[var(--ec-control)] text-[var(--ec-text)] hover:bg-[var(--ec-control-hover)]",
        outline: "border border-[var(--ec-border-strong)] bg-transparent text-[var(--ec-text)] hover:bg-[var(--ec-hover)]",
        danger: "bg-[var(--ec-danger)] text-white hover:bg-[var(--ec-danger-strong)]",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-3",
        xs: "h-7 px-2 text-xs",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} data-ui="button" data-variant={variant ?? "default"} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);

Button.displayName = "Button";
