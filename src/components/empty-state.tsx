"use client";

import Link from "next/link";
import { type LucideIcon, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Standard empty state for "no rows yet" surfaces. The audit asked for
 * consistent empty states with an icon + 1-line "what is this" + a
 * primary CTA + optional secondary "Learn more". Use this everywhere
 * a list/table is empty instead of bare text — it gives the operator
 * orientation and a path forward.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  primaryAction?: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      <div className="rounded-full bg-muted/40 p-3">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      ) : null}
      {primaryAction || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {primaryAction ? (
            primaryAction.href ? (
              <Button asChild size="sm">
                <Link href={primaryAction.href}>{primaryAction.label}</Link>
              </Button>
            ) : (
              <Button size="sm" onClick={primaryAction.onClick}>
                {primaryAction.label}
              </Button>
            )
          ) : null}
          {secondaryAction ? (
            secondaryAction.href ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
