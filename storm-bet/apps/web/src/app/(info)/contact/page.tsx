import type { Metadata } from 'next';
import { ContactForm } from '@/components/contact-form';
import { Prose } from '@/components/prose';

export const metadata: Metadata = { title: 'Kontakt' };

export default function ContactPage() {
  return (
    <div className="space-y-8">
      <Prose>
        <h1>Kontakt</h1>
        <p>
          Fragen zur Demo-Plattform, zu deinem Konto oder zum Datenschutz? Schreib uns – wir melden
          uns per E-Mail.
        </p>
      </Prose>
      <ContactForm />
    </div>
  );
}
