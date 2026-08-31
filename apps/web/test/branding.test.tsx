import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const settings = vi.hoisted(() => ({
  panelName: 'Storm Panel',
  announcement: '',
  announcementLevel: 'info' as 'info' | 'warning' | 'critical',
  worksDuringMaintenance: false,
  maintenanceMode: false,
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('@/lib/panel-settings', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/panel-settings')>('@/lib/panel-settings');
  return {
    ...actual,
    usePanelSettings: () => ({
      panelName: settings.panelName,
      panelUrl: '',
      brandColor: '#2563eb',
      announcement: settings.announcement,
      announcementLevel: settings.announcementLevel,
      registrationEnabled: true,
      requireEmailVerification: false,
      maintenanceMode: settings.maintenanceMode,
      maintenanceMessage: '',
      supportEmail: '',
    }),
    useWorksDuringMaintenance: () => settings.worksDuringMaintenance,
  };
});

const { hexToHslTriplet } = await import('@/lib/panel-settings');
const { AnnouncementBanner, MaintenanceBanner, fingerprint } = await import(
  '@/components/panel/banners'
);
const { StormLogo } = await import('@/components/brand');

describe('brand colour', () => {
  it('converts a hex to the HSL triplet the design tokens are stored in', () => {
    // The stylesheet defines --primary as `221 83% 53%`; the default brand
    // colour has to land back on it, or every untouched panel shifts hue the
    // moment this feature ships.
    expect(hexToHslTriplet('#2563eb')).toBe('221 83% 53%');
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%');
    expect(hexToHslTriplet('#ff0000')).toBe('0 100% 50%');
    expect(hexToHslTriplet('#00ff00')).toBe('120 100% 50%');
    expect(hexToHslTriplet('#0000ff')).toBe('240 100% 50%');
    expect(hexToHslTriplet('#808080')).toBe('0 0% 50%');
  });

  it('accepts the hex an admin may have typed in upper case', () => {
    expect(hexToHslTriplet('#A1B2C3')).toBe(hexToHslTriplet('#a1b2c3'));
    expect(hexToHslTriplet('  #2563eb  ')).toBe('221 83% 53%');
  });

  it('refuses anything that is not a six-digit hex, rather than emitting it', () => {
    // Whatever this returns is written straight into a CSS custom property, so
    // "not a colour" has to mean null and not a half-parsed string.
    for (const bad of [
      'red',
      '#fff',
      '#gggggg',
      'rgb(0,0,0)',
      '#2563eb; color: red',
      'red } :root { display: none',
      '',
    ]) {
      expect(hexToHslTriplet(bad), `${bad} must not become a colour`).toBeNull();
    }
  });
});

describe('panel name', () => {
  it('shows whatever the administrator renamed the panel to', () => {
    settings.panelName = 'Nordic Hosting';
    render(<StormLogo />);
    expect(screen.getByText('Nordic Hosting')).toBeInTheDocument();
    settings.panelName = 'Storm Panel';
  });
});

describe('AnnouncementBanner', () => {
  it('renders nothing when there is no announcement', () => {
    settings.announcement = '';
    const { container } = render(<AnnouncementBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message an administrator wrote', async () => {
    settings.announcement = 'Maintenance on Saturday at 20:00 UTC.';
    render(<AnnouncementBanner />);
    expect(await screen.findByText(/Maintenance on Saturday/)).toBeInTheDocument();
  });

  it('stays dismissed for that message, and comes back for the next one', async () => {
    window.localStorage.clear();
    settings.announcement = 'First announcement.';

    const first = render(<AnnouncementBanner />);
    await screen.findByText('First announcement.');
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('First announcement.')).not.toBeInTheDocument();
    first.unmount();

    // Reopening the panel must not bring the dismissed one back.
    const again = render(<AnnouncementBanner />);
    expect(again.container).toBeEmptyDOMElement();
    again.unmount();

    // A new announcement is a new message, and everyone should see it — the
    // whole point of the feature is that it reaches people.
    settings.announcement = 'Second announcement.';
    render(<AnnouncementBanner />);
    expect(await screen.findByText('Second announcement.')).toBeInTheDocument();
  });

  it('gives different messages different dismissal keys', () => {
    expect(fingerprint('First announcement.')).not.toBe(fingerprint('Second announcement.'));
    expect(fingerprint('Same')).toBe(fingerprint('Same'));
  });
});

describe('MaintenanceBanner', () => {
  it('reminds the administrator who can still use the panel', () => {
    settings.maintenanceMode = true;
    settings.worksDuringMaintenance = true;
    render(<MaintenanceBanner />);
    expect(screen.getByText(/Maintenance mode is on/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Turn it off/ })).toBeInTheDocument();
  });

  it('says nothing while maintenance is off', () => {
    settings.maintenanceMode = false;
    settings.worksDuringMaintenance = true;
    const { container } = render(<MaintenanceBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is never shown to someone who is locked out anyway', () => {
    settings.maintenanceMode = true;
    settings.worksDuringMaintenance = false;
    const { container } = render(<MaintenanceBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
