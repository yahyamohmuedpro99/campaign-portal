"use client";

import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

/**
 * Search box that owns its draft state internally, so keystrokes re-render
 * only this small component instead of the (large) page hosting it.
 *
 * Calls `onDebouncedChange` with the trimmed value once typing pauses for
 * `delay` ms; Enter applies immediately. When the page clears or replaces
 * the search programmatically, bump `resetKey` — the input remounts and
 * re-syncs its draft to `initialValue`.
 */

type DebouncedSearchInputProps = {
  onDebouncedChange: (value: string) => void;
  initialValue?: string;
  resetKey?: number | string;
  delay?: number;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
};

export function DebouncedSearchInput({ resetKey, ...props }: DebouncedSearchInputProps) {
  return <DebouncedSearchInputInner key={resetKey} {...props} />;
}

function DebouncedSearchInputInner({
  onDebouncedChange,
  initialValue = "",
  delay = 300,
  className,
  placeholder,
  "aria-label": ariaLabel,
}: Omit<DebouncedSearchInputProps, "resetKey">) {
  const [value, setValue] = useState(initialValue);

  // Keep the latest callback in a ref so a pending timeout always calls the
  // newest parent closure (parents re-create the handler every render).
  const onDebouncedChangeRef = useRef(onDebouncedChange);
  useEffect(() => {
    onDebouncedChangeRef.current = onDebouncedChange;
  });

  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function apply(next: string) {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    onDebouncedChangeRef.current(next.trim());
  }

  return (
    <Input
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => apply(next), delay);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          apply(value);
        }
      }}
      className={className}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}
