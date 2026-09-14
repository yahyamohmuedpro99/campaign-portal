"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * AlertDialog that requires the operator to type the exact ``confirmText``
 * (case-insensitive) before the destructive button enables. Used for the
 * high-blast-radius flows the audit flagged: workspace delete, user
 * delete, list delete on a large list, etc.
 *
 * Open is controlled. The dialog clears its input whenever it transitions
 * from closed → open so a stale match doesn't carry over.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  actionLabel = "Delete",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  actionLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    // Clear the typed confirmation each time the dialog opens (reset-on-prop-change).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setTyped("");
  }, [open]);

  const matches = typed.trim().toLowerCase() === confirmText.trim().toLowerCase();

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="typed-confirm" className="text-xs text-muted-foreground">
            Type <span className="font-mono font-medium">{confirmText}</span> to enable the action.
          </Label>
          <Input
            id="typed-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
            aria-invalid={!matches && typed.length > 0}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !matches}
            onClick={(e) => {
              e.preventDefault();
              if (matches) onConfirm();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
