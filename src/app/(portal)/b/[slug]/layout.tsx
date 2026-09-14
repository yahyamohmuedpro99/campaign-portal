import { requireMembership, myBrands } from '@/lib/brand';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { signOut } from '@/app/(auth)/login/actions';
import { BrandNav } from '@/components/portal/brand-nav';
import { LogOut } from 'lucide-react';

export default async function BrandLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const membership = await requireMembership(slug);
  const brands = await myBrands();

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-dvh bg-background">
        <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                {membership.code.slice(0, 2)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold leading-tight">{membership.name}</div>
                <div className="text-xs leading-tight text-muted-foreground">
                  {membership.country} · {membership.timezone}
                </div>
              </div>
            </div>
            <Badge variant={membership.role === 'owner' ? 'default' : 'secondary'} className="ml-1 shrink-0">
              {membership.role}
            </Badge>
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
