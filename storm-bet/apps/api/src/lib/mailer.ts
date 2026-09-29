import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

interface MailLogger {
  info(obj: object, msg?: string): void;
}

/**
 * Development mailer: writes the message to the log instead of sending it.
 * Verification and reset links are therefore visible in the API log when no
 * SMTP server is configured.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: MailLogger) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.info(
      { mail: { to: message.to, subject: message.subject, text: message.text } },
      'mail (not sent: no SMTP_URL)',
    );
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export const mailTemplates = {
  verifyEmail(appUrl: string, token: string, name: string): Omit<MailMessage, 'to'> {
    return {
      subject: 'STORM BET – Bitte bestätige deine E-Mail-Adresse',
      text: [
        `Hallo ${name},`,
        '',
        'bitte bestätige deine E-Mail-Adresse über den folgenden Link:',
        `${appUrl}/verify-email?token=${encodeURIComponent(token)}`,
        '',
        'Der Link ist 24 Stunden gültig. Wenn du dich nicht registriert hast, ignoriere diese E-Mail.',
        '',
        'STORM BET – Demo-Plattform, kein Echtgeld.',
      ].join('\n'),
    };
  },
  resetPassword(appUrl: string, token: string): Omit<MailMessage, 'to'> {
    return {
      subject: 'STORM BET – Passwort zurücksetzen',
      text: [
        'Du hast angefordert, dein Passwort zurückzusetzen:',
        `${appUrl}/reset-password?token=${encodeURIComponent(token)}`,
        '',
        'Der Link ist 30 Minuten gültig und kann nur einmal verwendet werden.',
        'Wenn du das nicht warst, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.',
      ].join('\n'),
    };
  },
};
