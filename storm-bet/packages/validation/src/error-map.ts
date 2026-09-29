import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/**
 * German defaults for zod issues that a schema does not word itself. Every
 * message a user can see must be German and free of technical jargon.
 */
export const germanErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Pflichtfeld' };
      return { message: 'Ungültiger Wert' };
    case ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: `Mindestens ${issue.minimum} Zeichen` };
      if (issue.type === 'array') return { message: `Mindestens ${issue.minimum} Einträge` };
      return { message: `Muss mindestens ${issue.minimum} sein` };
    case ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `Höchstens ${issue.maximum} Zeichen` };
      if (issue.type === 'array') return { message: `Höchstens ${issue.maximum} Einträge` };
      return { message: `Darf höchstens ${issue.maximum} sein` };
    case ZodIssueCode.invalid_enum_value:
      return { message: 'Ungültige Auswahl' };
    case ZodIssueCode.invalid_string:
      return { message: 'Ungültiges Format' };
    case ZodIssueCode.unrecognized_keys:
      return { message: 'Unbekannte Felder' };
    default:
      return { message: ctx.defaultError === 'Required' ? 'Pflichtfeld' : 'Ungültiger Wert' };
  }
};

z.setErrorMap(germanErrorMap);
