import fs from 'node:fs/promises'
import {planGlobalChat} from '../src/core/orchestrator/globalChat.js'

const defaultCredentials = {
  crm: 'eval', webcamgo: 'eval', specialk: 'eval', cmsAsiagoIt: 'eval',
  snowbulletin: 'eval', spine01: 'eval', nozomi: 'eval', wam: 'eval',
}
const cases = JSON.parse(await fs.readFile(new URL('../evals/router-cases.json', import.meta.url), 'utf8'))
const failures = []

for (const item of cases) {
  const actual = planGlobalChat({message: item.message, context: item.context || {}, history: item.history || [], credentials: item.credentials ?? defaultCredentials})
  const mismatch = Object.entries(item.expected).find(([key, value]) => actual?.[key] !== value)
  if (mismatch) failures.push({name: item.name, message: item.message, expected: item.expected, actual})
}

const score = Math.round(((cases.length - failures.length) / cases.length) * 1000) / 10
console.log(`Router eval: ${cases.length - failures.length}/${cases.length} (${score}%)`)
for (const failure of failures) console.error(JSON.stringify(failure))
if (failures.length) process.exitCode = 1
