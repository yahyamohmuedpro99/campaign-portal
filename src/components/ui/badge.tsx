import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 transition-[color,background-color]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        // Semantic states use the {soft ground + text} pairs from globals.css,
        // each verified >=4.5:1 against its own ground in BOTH moods. The old
        // `bg-destructive/15` composited the fill over whatever sat behind the
        // badge, so the real contrast depended on the surface underneath it.
        destructive: "border-transparent bg-danger-soft text-danger-text",
        success: "border-transparent bg-success-soft text-success-text",
        warning: "border-transparent bg-warning-soft text-warning-text",
        info: "border-transparent bg-info-soft text-info-text",
        outline: "text-foreground border-control",
        accent: "border-transparent bg-accent text-accent-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
