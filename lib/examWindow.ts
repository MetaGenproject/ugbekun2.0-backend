export type ExamWindowStatus = 'upcoming' | 'open' | 'ended'

export function parseMaybeDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

export function examWindowStatus(
  start?: Date | string | null,
  end?: Date | string | null,
  now = new Date()
): ExamWindowStatus {
  const startDate = parseMaybeDate(start)
  const endDate = parseMaybeDate(end)
  if (startDate && now < startDate) return 'upcoming'
  if (endDate && now > endDate) return 'ended'
  return 'open'
}

export function examWindowMessage(status: ExamWindowStatus, start?: Date | string | null, end?: Date | string | null) {
  const startDate = parseMaybeDate(start)
  const endDate = parseMaybeDate(end)
  if (status === 'upcoming') {
    return startDate
      ? `This examination opens on ${startDate.toLocaleString()}.`
      : 'This examination is not open yet.'
  }
  if (status === 'ended') {
    return endDate
      ? `This sitting closed on ${endDate.toLocaleString()}. Ask your school admin to reschedule the existing exam — a new exam is not required.`
      : 'This sitting has closed. Ask your school admin to reschedule the existing exam.'
  }
  return 'This examination is open.'
}
