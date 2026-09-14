'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2 } from 'lucide-react';

export function ContactSearch({ slug, defaultValue, exclusion }: {
  slug: string; defaultValue: string; exclusion?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = new URLSearchParams();
    if (value.trim()) p.set('q', value.trim());
    if (exclusion) p.set('exclusion', exclusion);
    const qs = p.toString();
    start(() => router.push(`/b/${slug}/contacts${qs ? `?${qs}` : ''}`));
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={value} onChange={(e) => setValue(e.target.value)} className="pl-8"
               placeholder="Name, email or customer reference" aria-label="Search contacts" />
      </div>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
      </Button>
    </form>
  );
}
