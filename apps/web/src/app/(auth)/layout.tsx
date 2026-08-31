import Link from 'next/link';
import { Activity, HardDrive, ShieldCheck, Terminal } from 'lucide-react';
import { PanelName, StormLogo } from '@/components/brand';

const HIGHLIGHTS = [
  {
    icon: Terminal,
    title: 'Live console',
    description: 'Stream output and issue commands the moment they are typed.',
  },
  {
    icon: Activity,
    title: 'Real metrics',
    description: 'CPU, memory, disk and network sampled straight from the container.',
  },
  {
    icon: HardDrive,
    title: 'Backups that restore',
    description: 'Scheduled archives to local disk or S3-compatible storage.',
  },
  {
    icon: ShieldCheck,
    title: 'Isolated by default',
    description: 'Every server is a hardened container with its own SFTP account.',
  },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Marketing rail: hidden on small screens where the form is the whole job. */}
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface-sunken lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="storm-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
        <div
          className="pointer-events-none absolute -left-32 top-1/4 h-[420px] w-[420px] rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, hsl(var(--primary)) 0%, transparent 70%)' }}
        />

        <Link href="/" className="relative z-10 w-fit">
          <StormLogo />
        </Link>

        <div className="relative z-10 max-w-md space-y-8">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight">
              Game server hosting,
              <br />
              under control.
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              <PanelName /> gives you the console, files, backups and automation for every server
              you run — on infrastructure you own.
            </p>
          </div>

          <ul className="space-y-4">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                  <item.icon className="h-4 w-4 text-primary" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs text-muted-foreground">
          <PanelName /> · self-hosted game server control
        </p>
      </aside>

      <main className="flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <StormLogo />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
