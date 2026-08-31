import fp from 'fastify-plugin';
import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyInstance } from 'fastify';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    mail: {
      send: (message: MailMessage) => Promise<void>;
      /** Opens a connection and authenticates, without sending anything. */
      verify: () => Promise<void>;
      enabled: boolean;
    };
  }
}

const layout = (title: string, body: string, action?: { label: string; url: string }): string => `
<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b0d10;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e8eb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#12151a;border:1px solid #232830;border-radius:14px;overflow:hidden">
      <tr><td style="padding:28px 32px 8px">
        <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#7c8794">Storm Panel</div>
        <h1 style="margin:10px 0 0;font-size:21px;font-weight:600;color:#f4f6f8">${title}</h1>
      </td></tr>
      <tr><td style="padding:12px 32px 24px;font-size:15px;line-height:1.6;color:#b6bec9">${body}</td></tr>
      ${
        action
          ? `<tr><td style="padding:0 32px 32px"><a href="${action.url}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;font-size:14px">${action.label}</a></td></tr>`
          : ''
      }
      <tr><td style="padding:18px 32px;border-top:1px solid #232830;font-size:12px;color:#6b7583">
        If you did not expect this email you can safely ignore it.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

export function renderMail(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): {
  html: string;
  text: string;
} {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('');
  const text = [title, '', ...paragraphs, action ? `\n${action.label}: ${action.url}` : ''].join(
    '\n',
  );
  return { html: layout(title, body, action), text };
}

export default fp(
  async function mailPlugin(app: FastifyInstance) {
    let transporter: Transporter | null = null;

    if (app.env.SMTP_HOST) {
      transporter = nodemailer.createTransport({
        host: app.env.SMTP_HOST,
        port: app.env.SMTP_PORT ?? 587,
        secure: app.env.SMTP_SECURE,
        auth: app.env.SMTP_USER
          ? { user: app.env.SMTP_USER, pass: app.env.SMTP_PASSWORD ?? '' }
          : undefined,
      });
    }

    app.decorate('mail', {
      enabled: transporter !== null,
      async verify() {
        if (!transporter) throw new Error('SMTP is not configured (set SMTP_HOST).');
        await transporter.verify();
      },
      async send(message: MailMessage) {
        if (!transporter) {
          // Without SMTP configured the panel still works; the link is logged so
          // a self-hosted operator can complete the flow manually.
          app.log.warn(
            { to: message.to, subject: message.subject },
            'SMTP is not configured — email not sent',
          );
          app.log.info({ body: message.text }, 'email body');
          return;
        }
        await transporter.sendMail({
          from: app.env.MAIL_FROM,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
      },
    });

    app.addHook('onClose', async () => {
      transporter?.close();
    });
  },
  { name: 'storm-mail', dependencies: ['storm-env'] },
);
