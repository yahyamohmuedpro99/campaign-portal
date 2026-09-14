import { redirect } from 'next/navigation';
import { myBrands } from '@/lib/brand';

/** Sends a signed-in person to their brand. Six accounts, one brand each. */
export default async function Home() {
  const brands = await myBrands();
  if (brands.length === 0) redirect('/no-access');
  redirect(`/b/${brands[0].slug}/dashboard`);
}
