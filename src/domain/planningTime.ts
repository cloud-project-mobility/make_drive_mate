import { parseLocalDateTime } from './helpers';

function sameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

/** Enumerate the actual instants for a local minute, including a repeated DST hour. */
export function localArrivalOptions(date: string, time: string): Date[] {
  const first = parseLocalDateTime(date, time);
  if (!first) return [];
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6)
    offsets.add(new Date(first.getTime() + hours * 3600000).getTimezoneOffset());
  const wall = first.getTime() - first.getTimezoneOffset() * 60000;
  return [...offsets]
    .map((offset) => new Date(wall + offset * 60000))
    .filter((candidate) => sameMinute(candidate, first))
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Keep the provider's exact instant until the user edits its local date/time fields. */
export function resolveArrival(
  date: string,
  time: string,
  selectedInstant: string | null,
): Date | null {
  const options = localArrivalOptions(date, time);
  if (selectedInstant) {
    const selected = new Date(selectedInstant);
    if (
      Number.isFinite(selected.getTime()) &&
      options.some((option) => sameMinute(option, selected))
    )
      return selected;
  }
  return options.length === 1 ? options[0] : null;
}

export function utcOffsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  return `UTC${minutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}
