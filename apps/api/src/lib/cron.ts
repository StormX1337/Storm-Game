import parser from 'cron-parser';

export interface CronParts {
  cronMinute: string;
  cronHour: string;
  cronDayOfMonth: string;
  cronMonth: string;
  cronDayOfWeek: string;
  timezone: string;
}

export function cronExpression(parts: CronParts): string {
  return [
    parts.cronMinute,
    parts.cronHour,
    parts.cronDayOfMonth,
    parts.cronMonth,
    parts.cronDayOfWeek,
  ].join(' ');
}

/** Next fire time for a schedule, or null when the expression is unusable. */
export function nextRunAt(parts: CronParts, from: Date = new Date()): Date | null {
  try {
    const interval = parser.parseExpression(cronExpression(parts), {
      currentDate: from,
      tz: parts.timezone || 'UTC',
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(parts: CronParts): boolean {
  return nextRunAt(parts) !== null;
}

/** Plain-English summary shown in the schedule list. */
export function describeCron(parts: CronParts): string {
  const {
    cronMinute: m,
    cronHour: h,
    cronDayOfMonth: dom,
    cronMonth: mo,
    cronDayOfWeek: dow,
  } = parts;

  if (m === '*' && h === '*') return 'Every minute';
  if (h === '*' && dom === '*' && mo === '*' && dow === '*') {
    if (/^\*\/(\d+)$/.test(m)) return `Every ${m.split('/')[1]} minutes`;
    return `Every hour at :${m.padStart(2, '0')}`;
  }
  if (/^\*\/(\d+)$/.test(h) && dom === '*' && mo === '*' && dow === '*') {
    return `Every ${h.split('/')[1]} hours at :${m.padStart(2, '0')}`;
  }
  if (dom === '*' && mo === '*' && dow === '*') {
    return `Daily at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  if (dom === '*' && mo === '*') {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = names[Number(dow)] ?? dow;
    return `Every ${day} at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return cronExpression(parts);
}
