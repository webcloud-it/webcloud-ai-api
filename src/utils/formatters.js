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
