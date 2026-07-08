export function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .trim()
}

export function matchesText(value, q) {
  return normalizeText(value).includes(normalizeText(q))
}
