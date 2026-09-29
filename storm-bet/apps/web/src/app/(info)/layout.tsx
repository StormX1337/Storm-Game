import { DemoBanner } from '@/components/shell/demo-banner';
import { Footer } from '@/components/shell/footer';
import { Header } from '@/components/shell/header';

export default function InfoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DemoBanner />
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10 lg:py-14">{children}</main>
      <Footer />
    </>
  );
}
