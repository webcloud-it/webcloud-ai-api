export function groupByKey(
  items = [],
  getKey,
  createItem = item => ({...item}),
  mergeItem = existing => existing
) {
  const groups = new Map()

  for (const item of items) {
    const key = getKey(item)

    if (groups.has(key)) {
      groups.set(key, mergeItem(groups.get(key), item))
    } else {
      groups.set(key, createItem(item))
    }
  }

  return [...groups.values()]
}
