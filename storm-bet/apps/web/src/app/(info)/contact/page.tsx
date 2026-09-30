import type { Metadata } from 'next';
import { ContactForm } from '@/components/contact-form';
import { Prose } from '@/components/prose';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Kontakt') };
}

export default async function ContactPage() {
  const t = await getT();
  return (
    <div className="space-y-8">
      <Prose>
        <h1>{t('Kontakt')}</h1>
        <p>
          {t(
            'Fragen zur Demo-Plattform, zu deinem Konto oder zum Datenschutz? Schreib uns – wir melden uns per E-Mail.',
          )}
        </p>
      </Prose>
      <ContactForm />
    </div>
  );
}
