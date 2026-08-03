export function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
}

export function compactText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeSearchText(value = '') {
  return compactText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export function normalizeComparableText(value = '') {
  return normalizeSearchText(value)
    .replace(/[^a-z0-9@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchesText(value, q) {
  return normalizeText(value).includes(normalizeText(q))
}
