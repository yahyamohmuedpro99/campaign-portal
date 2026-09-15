import { requireMembership, myBrands } from '@/lib/brand';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { signOut } from '@/app/(auth)/login/actions';
import { BrandNav } from '@/components/portal/brand-nav';
import { LogOut } from 'lucide-react';
import { brandStyle, brandPlace } from '@/lib/brand-identity';

export default async function BrandLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const membership = await requireMembership(slug);
  const brands = await myBrands();

  return (
    <TooltipProvider delayDuration={200}>
      <div data-brand={slug} style={brandStyle(slug)} className="min-h-dvh bg-background">
        {/* A rule in the brand's colour across the top: the cheapest possible constant
            reminder of which company's data is on screen. */}
        <div aria-hidden className="h-[3px] bg-brand" />
        <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand text-[11px] font-bold tracking-[0.06em] text-brand-contrast">
                {membership.code.slice(0, 2)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold leading-tight">{membership.name}</div>
                <div className="text-xs leading-tight text-muted-foreground">
                  {brandPlace(slug) ?? membership.country}, {membership.timezone.split('/').pop()?.replace('_', ' ')} time
                </div>
              </div>
            </div>
            {/* Quiet on purpose. The brand colour means "this company's data"; spending it
                on a role chip would make the chrome compete with the figures. */}
            <span className="ml-1 shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {membership.role}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {brands.length > 1 && (
                <select defaultValue={slug} className="hidden rounded-md border bg-card px-2 py-1 text-xs sm:block">
                  {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
                </select>
              )}
              <form action={signOut}>
                <Button type="submit" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <LogOut className="size-3.5" />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </form>
            </div>
          </div>
          <BrandNav slug={slug} />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </TooltipProvider>
  );
}
