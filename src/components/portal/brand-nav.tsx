'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: 'dashboard', label: 'Dashboard' },
  { href: 'contacts', label: 'Contacts' },
  { href: 'campaigns', label: 'Campaigns' },
  { href: 'data', label: 'Data health' },
];

export function BrandNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  return (
    <nav className="mx-auto max-w-7xl px-2 sm:px-4">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const href = `/b/${slug}/${t.href}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={t.href}>
              <Link href={href}
                className={cn('inline-block whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
                  active ? 'border-primary font-medium text-foreground'
                         : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
