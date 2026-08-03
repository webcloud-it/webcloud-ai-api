import {normalizeSearchText} from '../../../../utils/text.js'

const MONTH_EXPRESSION_PATTERN =
  /^(?:gennaio|gen|febbraio|feb|marzo|mar|aprile|apr|maggio|mag|giugno|giu|luglio|lug|agosto|ago|settembre|sett|set|ottobre|ott|novembre|nov|dicembre|dic)(?:\s+20\d{2})?$/

export function normalizeMonthExpression(value = '') {
  const text = normalizeSearchText(value)
    .replace(/[.,!?;:]+$/g, '')
    .trim()

  return MONTH_EXPRESSION_PATTERN.test(text) ? text : null
}

export function isMonthExpression(value = '') {
  return Boolean(normalizeMonthExpression(value))
}
