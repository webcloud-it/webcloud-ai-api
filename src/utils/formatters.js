export function formatDate(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleDateString('it-IT')
}

export function formatDateTime(value) {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

// Directus communication_date is a wall-clock ISO value without an offset.
// Preserve that recorded time; convert explicitly zoned instants to Europe/Rome.
export function formatRecordedDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const input = value.trim()
  const dateOnly = input.length === 10
  const time = input.slice(10)
  const zoned = input.endsWith('Z') || time.includes('+') || time.includes('-')
  const date = new Date(zoned || dateOnly ? input : `${input}Z`)
  if (Number.isNaN(date.getTime())) return null
  const options = {dateStyle: 'long', timeZone: zoned ? 'Europe/Rome' : 'UTC'}
  const day = new Intl.DateTimeFormat('it-IT', options).format(date)
  if (dateOnly) return day
  return `${day} alle ${new Intl.DateTimeFormat('it-IT', {hour: '2-digit', minute: '2-digit', timeZone: options.timeZone}).format(date)}`
}

export function formatBytes(value) {
  const bytes = Number(value || 0)

  if (!bytes) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const size = bytes / 1024 ** index

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatCurrency(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) return String(value)

  return number.toLocaleString('it-IT', {
    style: 'currency',
    currency: 'EUR',
  })
}

export function buildCountLabel(rawCount, groupedCount, label, options = {}) {
  const groupedWord = options.groupedWord || 'raggruppati'

  if (rawCount === groupedCount) {
    return `Ho trovato ${rawCount} ${label}.`
  }

  return `Ho trovato ${rawCount} ${label}, ${groupedWord} in ${groupedCount} voci.`
}
