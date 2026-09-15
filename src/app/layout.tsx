import type { Metadata } from 'next';
import { Archivo } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

/**
 * One family, doing every job.
 *
 * Archivo is a grotesque drawn for signage: tight apertures, a strong lining figure set,
 * and enough weight range that display, interface and data can be told apart by weight and
 * size rather than by introducing a second typeface. A portal whose content is almost
 * entirely numbers needs figures that line up and hold at small sizes more than it needs a
 * display face.
 */
const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Campaign Portal',
  description: 'Client campaign portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${archivo.variable} antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
