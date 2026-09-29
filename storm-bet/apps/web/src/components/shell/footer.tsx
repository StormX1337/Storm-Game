import Link from 'next/link';
import { getPlatformMeta } from '@/lib/server-api';
import { Brand } from './brand';

const LINKS = [
  { href: '/sports', label: 'Sportarten' },
  { href: '/live', label: 'Live' },
  { href: '/responsible-gaming', label: 'Verantwortungsvolles Spielen' },
  { href: '/terms', label: 'Nutzungsbedingungen' },
  { href: '/privacy', label: 'Datenschutz' },
  { href: '/contact', label: 'Kontakt' },
];

export async function Footer() {
  const { odds } = await getPlatformMeta();
  return (
    <footer className="mt-16 border-t border-border bg-surface/60">
      <div className="mx-auto grid max-w-[1600px] gap-8 px-4 py-10 md:grid-cols-[1.2fr_1fr] lg:px-6">
        <div className="space-y-4">
          <Brand alwaysShowName />
          <p className="max-w-md text-sm leading-relaxed text-fg-muted">
            STORM BET ist eine Demonstrationsplattform.{' '}
            {odds.isSimulated
              ? 'Alle Spiele, Teams und Quoten sind simuliert.'
              : `Spiele, Quoten und Ergebnisse stammen von ${odds.name}; Angaben ohne Gewähr.`}{' '}
            Gewettet wird ausschließlich mit Demo-Guthaben ohne Geldwert. Es gibt keine
            Einzahlungen, keine Auszahlungen und keine Gewinnversprechen.
          </p>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="grid size-8 place-items-center rounded-full border border-border-strong text-[11px] font-bold text-fg-muted">
              18+
            </span>
            <span>
              Glücksspiel kann süchtig machen. Hilfe unter{' '}
              <a
                href="https://www.check-dein-spiel.de"
                className="underline underline-offset-2 hover:text-fg"
                rel="noopener noreferrer"
                target="_blank"
              >
                check-dein-spiel.de
              </a>{' '}
              · BZgA-Hotline 0800 1 37 27 00 (kostenlos)
            </span>
          </div>
        </div>
        <nav
          aria-label="Fußzeile"
          className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 md:justify-self-end"
        >
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-fg-muted transition-colors hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-[1600px] px-4 py-4 text-xs text-fg-subtle lg:px-6">
          © {new Date().getFullYear()} STORM BET · Demo-Software ohne Glücksspiellizenz · Kein
          Echtgeldbetrieb
        </p>
      </div>
    </footer>
  );
}
