'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Card, Field, Input, Textarea } from '@storm-bet/ui';
import { contactSchema, type ContactInput } from '@storm-bet/validation';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, errorMessage } from '@/lib/api-client';
import { useSession } from './providers/session';
import { useT } from '@/i18n/client';

export function ContactForm() {
  const t = useT();
  const { user } = useSession();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: user?.displayName ?? '',
      email: user?.email ?? '',
      subject: '',
      message: '',
    },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/contact', { body: values });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  if (sent) {
    return (
      <Card className="p-6 text-center">
        <CheckCircle2 className="mx-auto size-8 text-up" aria-hidden="true" />
        <p className="mt-3 font-semibold">{t('Nachricht gesendet')}</p>
        <p className="mt-1 text-sm text-fg-muted">
          {t('Danke! Wir antworten an die angegebene E-Mail-Adresse.')}
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error ? (
          <p role="alert" className="text-sm text-down sm:col-span-2">
            {error}
          </p>
        ) : null}
        <Field label={t('Name')} htmlFor="name" error={t(errors.name?.message)}>
          <Input id="name" autoComplete="name" invalid={!!errors.name} {...form.register('name')} />
        </Field>
        <Field label={t('E-Mail-Adresse')} htmlFor="email" error={t(errors.email?.message)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            invalid={!!errors.email}
            {...form.register('email')}
          />
        </Field>
        <Field
          label={t('Betreff')}
          htmlFor="subject"
          error={t(errors.subject?.message)}
          className="sm:col-span-2"
        >
          <Input id="subject" invalid={!!errors.subject} {...form.register('subject')} />
        </Field>
        <Field
          label={t('Nachricht')}
          htmlFor="message"
          error={t(errors.message?.message)}
          className="sm:col-span-2"
        >
          <Textarea
            id="message"
            rows={6}
            invalid={!!errors.message}
            {...form.register('message')}
          />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" loading={isSubmitting}>
            {t('Nachricht senden')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
