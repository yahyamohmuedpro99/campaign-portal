"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a media query.
 *
 * `initial` is what renders before mount. Under `output: "export"` the HTML is
 * prerendered, so the first client render must match it or React reports a
 * hydration mismatch — hence the default rather than reading matchMedia during
 * render. Pick the default that matches the prerendered markup.
 */
export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    // Sync once on mount: `initial` is a guess chosen to match the prerendered
    // markup, so the real value is only knowable here. The functional form lets
    // React bail out when the guess was already right, which is the common case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches((prev) => (prev === mql.matches ? prev : mql.matches));
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `md` breakpoint. Defaults to desktop, matching the prerender. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)", true);
}
