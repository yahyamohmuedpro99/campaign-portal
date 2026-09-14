/**
 * Everything under here is for people with no account.
 *
 * It deliberately shares nothing with the brand layout: no navigation, no brand switcher,
 * no session lookup. The session proxy also skips these paths entirely, so a shared report
 * never touches the portal's auth handling.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background">{children}</div>;
}
