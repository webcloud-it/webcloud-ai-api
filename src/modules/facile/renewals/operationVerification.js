const PLESK_BLOCKING_CODES = new Set([
  'missing_plesk_integration_id',
  'plesk_domain_not_linked',
  'plesk_subscription_not_found',
  'expiration_mismatch',
  'base_plan_mismatch',
  'plesk_subscription_not_synced',
  'plesk_subscription_locked',
])

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return value?.id ? String(value.id) : null
  const normalized = String(value).trim()
  return normalized || null
}

function normalizeDateOnly(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function comparableValue(value, field = '') {
  if (field === 'authCode') {
    if (value && typeof value === 'object' && 'isSet' in value) {
      return Boolean(value.isSet)
    }
    return Boolean(value)
  }

  if (field === 'toTransfer' || field === 'supplier' || field === 'group' || field === 'macro' || field === 'plan' || field === 'priceListVersion') {
    return normalizeId(value)
  }

  if (field === 'invoiceDate' || field === 'subscriptionEndDate' || /(?:endsOn|startsOn|date)$/i.test(field)) {
    return normalizeDateOnly(value)
  }

  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean' || typeof value === 'number') return value

  if (typeof value === 'object') {
    const id = normalizeId(value)
    if (id) return id
    return JSON.stringify(value)
  }

  const number = Number(value)
  if (typeof value !== 'string' && Number.isFinite(number)) return number

  return normalizeText(value)
}

function sameValue(first, second, field = '') {
  const left = comparableValue(first, field)
  const right = comparableValue(second, field)

  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) < 0.000001
  }

  return left === right
}

function publicValue(value, field = '') {
  if (field === 'authCode') {
    const isSet = comparableValue(value, field) === true
    return {isSet, sensitive: true}
  }

  if (value && typeof value === 'object') {
    if ('id' in value || 'name' in value) {
      return {
        id: normalizeId(value),
        name: value?.name || value?.label || null,
      }
    }
  }

  return value ?? null
}

function getServiceFlag(service = {}, field) {
  if (field === 'toRenew') return service?.toRenew === true || service?.to_renew === true
  if (field === 'dontRenew') return service?.dontRenew === true || service?.dont_renew === true
  if (field === 'autoRenew') return service?.autoRenew === true || service?.auto_renew === true
  if (field === 'toTransfer') return service?.toTransfer ?? service?.to_transfer ?? null
  if (field === 'invoiceDate') return service?.invoiceDate ?? service?.invoice_date ?? null
  if (field === 'pleskPlansSync') {
    return service?.pleskPlansSync === true || service?.plesk_plans_sync === true
  }
  if (field === 'authCode') {
    if (typeof service?.authCodeSet === 'boolean') return service.authCodeSet
    if (typeof service?.auth_code_set === 'boolean') return service.auth_code_set
    return Boolean(service?.authCode ?? service?.auth_code)
  }
  return undefined
}

function collectSubscriptions(service = {}) {
  const output = []
  const seen = new Set()

  const visit = subscription => {
    if (!subscription) return
    const id = normalizeId(subscription)

    if (id && !seen.has(id)) {
      seen.add(id)
      output.push(subscription)
    }

    for (const child of subscription?.suppliersSubscriptions || subscription?.supplierSubscriptions || []) {
      visit(child)
    }
  }

  for (const subscription of service?.subscriptions || []) visit(subscription)
  return output
}

function getSubscriptionEndDate(subscription = {}) {
  return subscription?.endsOn ?? subscription?.ends_on ?? null
}

function buildCheck({field, label = null, expected, actual, source = 'crm'} = {}) {
  return {
    field,
    label: label || field,
    expected: publicValue(expected, field),
    actual: publicValue(actual, field),
    ok: sameValue(expected, actual, field),
    source,
  }
}

function completedStatus(result = {}) {
  return result?.data?.result?.status || result?.data?.status || null
}

function shouldVerify(result = {}) {
  if (result?.intent !== 'action-result') return false
  return completedStatus(result) === 'completed'
}

function buildCatalogVerificationPlan(result = {}) {
  const mutation = result?.data?.result
  const entity = mutation?.target?.entity
  const targetId = normalizeId(mutation?.target)
  const changes = Array.isArray(mutation?.changes) ? mutation.changes : []

  if (!entity || !targetId || !changes.length) return null

  return {
    kind: 'catalog',
    entity,
    targetId,
    targetLabel: mutation?.target?.name || targetId,
    changes,
  }
}

function buildServiceActionPlan(result = {}) {
  const action = result?.data?.action
  const serviceId = normalizeId(action?.target)
  const changes = Array.isArray(action?.changes) ? action.changes : []

  if (!serviceId || !changes.length) return null

  return {
    kind: 'service',
    serviceId,
    targetLabel: action?.target?.label || serviceId,
    subscriptionId: normalizeId(action?.subscription),
    changes,
    verifyPlesk: false,
  }
}

function buildRenewalPlan(result = {}) {
  const data = result?.data?.result || {}
  const serviceId = normalizeId(data?.service)

  if (!serviceId) return null

  const changes = []
  let verifyPlesk = false

  if (data?.customer?.subscription && data?.supplier?.subscription) {
    changes.push({
      field: 'subscriptionEndDate',
      label: 'scadenza cliente',
      subscriptionId: normalizeId(data.customer.subscription),
      to: data.customer.subscription.endsOn,
    })
    changes.push({
      field: 'subscriptionEndDate',
      label: 'scadenza fornitore',
      subscriptionId: normalizeId(data.supplier.subscription),
      to: data.supplier.subscription.endsOn,
    })
    verifyPlesk = data?.customer?.plesk?.required === true && data?.customer?.plesk?.updated === true
  } else if (data?.subscription) {
    changes.push({
      field: 'subscriptionEndDate',
      label: 'scadenza sottoscrizione',
      subscriptionId: normalizeId(data.subscription),
      to: data.subscription.endsOn,
    })
    verifyPlesk = data?.plesk?.required === true && data?.plesk?.updated === true
  }

  const flags = data?.service?.flags || data?.customer?.service?.flags || null
  if (flags && Object.prototype.hasOwnProperty.call(flags, 'toRenew')) {
    changes.push({field: 'toRenew', label: 'DA RINNOVARE', to: flags.toRenew})
  }

  if (!changes.length) return null

  return {
    kind: 'service',
    serviceId,
    targetLabel: data?.service?.name || serviceId,
    changes,
    verifyPlesk,
  }
}

function buildVerificationPlan(result = {}) {
  return (
    buildCatalogVerificationPlan(result) ||
    buildServiceActionPlan(result) ||
    buildRenewalPlan(result)
  )
}

function normalizeAuditDomain(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\.$/, '')
    .replace(/[/?#].*$/, '')
}

function issueMatchesService(issue = {}, service = {}) {
  const serviceId = normalizeId(service)
  const domainId = normalizeId(service?.domains_id || service?.domain)
  const domainNames = new Set(
    [service?.domains_id?.name, service?.domain?.name, service?.name]
      .map(normalizeAuditDomain)
      .filter(Boolean)
  )

  const issueServiceIds = [
    issue?.service?.id,
    issue?.crm?.serviceId,
    ...(issue?.service?.services || []).map(item => item?.id),
    ...(issue?.service?.candidateDomains || []).map(item => item?.serviceId),
  ]
    .filter(Boolean)
    .map(String)

  const issueDomainIds = [
    issue?.service?.domainId,
    ...(issue?.service?.candidateDomains || []).map(item => item?.domainId),
  ]
    .filter(Boolean)
    .map(String)

  const issueDomainNames = [
    issue?.service?.domainName,
    issue?.plesk?.name,
    ...(issue?.service?.candidateDomains || []).map(item => item?.domainName),
  ]
    .map(normalizeAuditDomain)
    .filter(Boolean)

  return (
    (serviceId && issueServiceIds.includes(serviceId)) ||
    (domainId && issueDomainIds.includes(domainId)) ||
    issueDomainNames.some(name => domainNames.has(name))
  )
}

async function verifyCatalogPlan(plan, queryCatalog) {
  if (typeof queryCatalog !== 'function') {
    throw new Error('Provider catalogo non disponibile per la verifica')
  }

  const response = await queryCatalog({
    operation: 'detail',
    entity: plan.entity,
    filters: [{field: 'id', operator: 'equals', value: plan.targetId}],
    sort: [{field: 'id', direction: 'asc'}],
    limit: 2,
    offset: 0,
    source: 'post-operation-verification',
  })

  const record = Array.isArray(response?.items) ? response.items[0] : null
  if (!record) throw new Error('Il record modificato non è stato trovato nel catalogo')

  const checks = plan.changes.map(change =>
    buildCheck({
      field: change.field,
      label: change.label,
      expected: change.to,
      actual: record?.[change.field],
      source: 'catalog',
    })
  )

  return {checks, warnings: [], target: {type: plan.entity, id: plan.targetId, label: plan.targetLabel}}
}

async function verifyServicePlan(plan, loadServices, auditPlesk) {
  if (typeof loadServices !== 'function') {
    throw new Error('Provider servizi non disponibile per la verifica')
  }

  const services = await loadServices()
  const service = (Array.isArray(services) ? services : []).find(
    item => normalizeId(item) === plan.serviceId
  )

  if (!service) throw new Error('Il servizio modificato non è stato trovato dopo il ricaricamento')

  const subscriptions = collectSubscriptions(service)
  const checks = plan.changes.map(change => {
    if (change.field === 'subscriptionEndDate') {
      const subscriptionId = normalizeId(change.subscriptionId || plan.subscriptionId)
      const subscription = subscriptions.find(item => normalizeId(item) === subscriptionId)
      return buildCheck({
        field: 'subscriptionEndDate',
        label: change.label,
        expected: change.to,
        actual: subscription ? getSubscriptionEndDate(subscription) : null,
        source: 'services',
      })
    }

    return buildCheck({
      field: change.field,
      label: change.label,
      expected: change.to,
      actual: getServiceFlag(service, change.field),
      source: 'services',
    })
  })

  const warnings = []

  if (plan.verifyPlesk) {
    if (typeof auditPlesk !== 'function') {
      warnings.push({code: 'plesk-verification-unavailable', message: 'Verifica Plesk non disponibile.'})
    } else {
      try {
        const audit = await auditPlesk()
        const issues = (Array.isArray(audit?.items) ? audit.items : []).filter(
          issue => issueMatchesService(issue, service) && PLESK_BLOCKING_CODES.has(String(issue?.code || ''))
        )

        checks.push({
          field: 'plesk',
          label: 'sincronizzazione Plesk',
          expected: 'nessuna anomalia',
          actual: issues.length ? issues.map(issue => issue.code) : 'nessuna anomalia',
          ok: issues.length === 0,
          source: 'plesk-audit',
        })
      } catch (error) {
        warnings.push({
          code: 'plesk-verification-failed',
          message: error?.message || 'Audit Plesk non riuscito.',
        })
      }
    }
  }

  return {
    checks,
    warnings,
    target: {type: 'service', id: plan.serviceId, label: plan.targetLabel || service?.name || plan.serviceId},
  }
}

function buildVerificationStatus({checks = [], warnings = []} = {}) {
  if (!checks.length) return 'completed-with-warning'
  if (checks.some(check => check.ok !== true)) return 'verification-failed'
  if (warnings.length) return 'completed-with-warning'
  return 'completed-and-verified'
}

function verificationReply(status, verification) {
  if (status === 'completed-and-verified') {
    return 'Verifica successiva completata: lo stato effettivo corrisponde alla modifica richiesta.'
  }

  if (status === 'completed-with-warning') {
    return 'La modifica risulta applicata, ma una parte della verifica successiva non è stata completata. Controlla gli avvisi riportati.'
  }

  const mismatches = (verification?.checks || [])
    .filter(check => check.ok !== true)
    .map(check => check.label)
    .filter(Boolean)

  return mismatches.length
    ? `Attenzione: la verifica successiva non ha confermato ${mismatches.join(', ')}. La modifica richiede un controllo manuale.`
    : 'Attenzione: non è stato possibile verificare lo stato effettivo dopo la modifica. È necessario un controllo manuale.'
}

function auditVerification(verification = {}) {
  try {
    console.info(
      '[renewals-post-operation-verification]',
      JSON.stringify({
        timestamp: verification.checkedAt || new Date().toISOString(),
        status: verification.status || null,
        target: verification.target
          ? {
              type: verification.target.type || null,
              id: verification.target.id || null,
              label: verification.target.label || null,
            }
          : null,
        failedFields: (verification.checks || [])
          .filter(check => check.ok !== true)
          .map(check => check.field),
        warningCodes: (verification.warnings || []).map(warning => warning.code),
        errorCode: verification.error?.code || null,
      })
    )
  } catch {}
}

function applyVerification(result, verification, status, durationMs) {
  auditVerification(verification)
  const currentResult = result?.data?.result || {}

  return {
    ...result,
    reply: [result?.reply, verificationReply(status, verification)].filter(Boolean).join('\n\n'),
    data: {
      ...(result?.data || {}),
      status,
      verification,
      result: {
        ...currentResult,
        status,
        verification,
      },
    },
    meta: {
      ...(result?.meta || {}),
      verificationStatus: status,
      verificationMs: durationMs,
    },
  }
}

export async function verifyCompletedOperationResult({
  result,
  loadServices,
  queryCatalog,
  auditPlesk,
} = {}) {
  if (!shouldVerify(result)) return result

  const startedAt = Date.now()
  const plan = buildVerificationPlan(result)

  if (!plan) {
    const verification = {
      status: 'completed-with-warning',
      checkedAt: new Date().toISOString(),
      target: null,
      checks: [],
      warnings: [
        {
          code: 'verification-plan-unavailable',
          message: 'Il risultato non contiene dati sufficienti per una verifica automatica.',
        },
      ],
    }

    return applyVerification(
      result,
      verification,
      verification.status,
      Date.now() - startedAt
    )
  }

  try {
    const execution =
      plan.kind === 'catalog'
        ? await verifyCatalogPlan(plan, queryCatalog)
        : await verifyServicePlan(plan, loadServices, auditPlesk)

    const status = buildVerificationStatus(execution)
    const verification = {
      status,
      checkedAt: new Date().toISOString(),
      target: execution.target,
      checks: execution.checks,
      warnings: execution.warnings,
    }

    return applyVerification(result, verification, status, Date.now() - startedAt)
  } catch (error) {
    const verification = {
      status: 'verification-failed',
      checkedAt: new Date().toISOString(),
      target: plan?.targetId
        ? {type: plan.entity || plan.kind, id: plan.targetId, label: plan.targetLabel || plan.targetId}
        : {type: 'service', id: plan?.serviceId || null, label: plan?.targetLabel || plan?.serviceId || null},
      checks: [],
      warnings: [],
      error: {
        code: 'post-operation-verification-failed',
        message: error?.message || 'Errore verifica post-operazione',
      },
    }

    return applyVerification(
      result,
      verification,
      verification.status,
      Date.now() - startedAt
    )
  }
}
