function normalizeText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function field(config) {
  return {
    nullable: false,
    aliases: [],
    ...config,
  }
}

function definition(config) {
  return {
    aliases: [],
    ...config,
    fields: new Map(Object.entries(config.fields || {})),
  }
}

const DEFINITIONS = new Map(
  [
    definition({
      id: 'providers',
      singular: 'fornitore',
      aliases: ['fornitore', 'provider', 'supplier'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
      },
    }),
    definition({
      id: 'customers',
      singular: 'cliente',
      aliases: ['cliente', 'azienda'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        type: field({label: 'tipo', type: 'string', nullable: true, aliases: ['tipo', 'tipologia']}),
        group: field({
          label: 'gruppo',
          type: 'relation',
          relationEntity: 'groups',
          nullable: true,
          aliases: ['gruppo', 'gruppo aziendale'],
        }),
        priceListVersion: field({
          label: 'versione listino',
          type: 'relation',
          relationEntity: 'price-lists',
          nullable: true,
          aliases: ['listino', 'versione listino', 'listino prezzi'],
        }),
      },
    }),
    definition({
      id: 'groups',
      singular: 'gruppo',
      aliases: ['gruppo', 'gruppo aziendale'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        priceListVersion: field({
          label: 'versione listino',
          type: 'relation',
          relationEntity: 'price-lists',
          nullable: true,
          aliases: ['listino', 'versione listino', 'listino prezzi'],
        }),
      },
    }),
    definition({
      id: 'plans',
      singular: 'piano',
      aliases: ['piano', 'plan', 'offerta'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        description: field({label: 'descrizione', type: 'string', nullable: true, aliases: ['descrizione']}),
        duration: field({label: 'durata', type: 'integer', nullable: true, aliases: ['durata', 'mesi', 'durata in mesi']}),
        activationFee: field({
          label: 'costo di attivazione',
          type: 'number',
          nullable: true,
          aliases: ['costo di attivazione', 'attivazione', 'prezzo di attivazione'],
        }),
        supplier: field({
          label: 'fornitore',
          type: 'relation',
          relationEntity: 'providers',
          nullable: true,
          aliases: ['fornitore', 'provider', 'supplier'],
        }),
      },
    }),
    definition({
      id: 'addons',
      singular: 'add-on',
      aliases: ['add-on', 'addon', 'componente aggiuntivo'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        description: field({label: 'descrizione', type: 'string', nullable: true, aliases: ['descrizione']}),
        duration: field({label: 'durata', type: 'integer', nullable: true, aliases: ['durata', 'mesi', 'durata in mesi']}),
        activationFee: field({
          label: 'costo di attivazione',
          type: 'number',
          nullable: true,
          aliases: ['costo di attivazione', 'attivazione', 'prezzo di attivazione'],
        }),
        supplier: field({
          label: 'fornitore',
          type: 'relation',
          relationEntity: 'providers',
          nullable: true,
          aliases: ['fornitore', 'provider', 'supplier'],
        }),
      },
    }),
    definition({
      id: 'resources',
      singular: 'tipo di risorsa',
      aliases: ['risorsa', 'tipo di risorsa'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        key: field({label: 'chiave', type: 'string', nullable: true, aliases: ['chiave', 'key', 'codice']}),
        category: field({label: 'categoria', type: 'string', nullable: true, aliases: ['categoria']}),
        unitOfMeasurement: field({
          label: 'unità di misura',
          type: 'string',
          nullable: true,
          aliases: ['unita di misura', 'unità di misura', 'misura'],
        }),
      },
    }),
    definition({
      id: 'service-types',
      singular: 'tipo di servizio',
      aliases: ['tipo di servizio', 'categoria di servizio'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        macro: field({
          label: 'macro tipo di servizio',
          type: 'relation',
          relationEntity: 'macro-service-types',
          nullable: true,
          aliases: ['macro tipo', 'macro tipo di servizio', 'macro categoria'],
        }),
      },
    }),
    definition({
      id: 'macro-service-types',
      singular: 'macro tipo di servizio',
      aliases: ['macro tipo di servizio', 'macro categoria di servizio'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
      },
    }),
    definition({
      id: 'price-lists',
      singular: 'listino',
      aliases: ['listino', 'versione listino', 'listino prezzi'],
      fields: {
        name: field({label: 'nome', type: 'string', aliases: ['nome', 'denominazione']}),
        version: field({label: 'versione', type: 'integer', nullable: true, aliases: ['versione', 'numero versione']}),
      },
    }),
    definition({
      id: 'plan-prices',
      singular: 'prezzo del piano',
      aliases: ['prezzo del piano', 'prezzo', 'tariffa'],
      fields: {
        price: field({label: 'prezzo', type: 'number', nullable: true, aliases: ['prezzo', 'costo', 'tariffa', 'importo']}),
        plan: field({
          label: 'piano',
          type: 'relation',
          relationEntity: 'plans',
          nullable: false,
          aliases: ['piano'],
        }),
        priceListVersion: field({
          label: 'versione listino',
          type: 'relation',
          relationEntity: 'price-lists',
          nullable: false,
          aliases: ['listino', 'versione listino', 'listino prezzi'],
        }),
      },
    }),
  ].map(item => [item.id, item])
)

export function getEntityMutationDefinitions() {
  return [...DEFINITIONS.values()]
}

export function getEntityMutationDefinition(entityId = '') {
  return DEFINITIONS.get(String(entityId || '').trim()) || null
}

export function findEntityMutationDefinitionByAlias(value = '') {
  const text = normalizeText(value)
  if (!text) return null

  const exact = [...DEFINITIONS.values()].find(definition =>
    [definition.id, definition.singular, ...definition.aliases]
      .filter(Boolean)
      .some(alias => normalizeText(alias) === text)
  )

  if (exact) return exact

  return [...DEFINITIONS.values()]
    .sort((first, second) => second.singular.length - first.singular.length)
    .find(definition =>
      [definition.singular, ...definition.aliases]
        .filter(Boolean)
        .some(alias => new RegExp(`\\b${normalizeText(alias).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(text))
    ) || null
}

export function findEntityMutationField(definition, value = '') {
  if (!definition) return null
  const text = normalizeText(value)
  if (!text) return null

  for (const [id, item] of definition.fields.entries()) {
    if ([id, item.label, ...(item.aliases || [])].some(alias => normalizeText(alias) === text)) {
      return {id, ...item}
    }
  }

  const candidates = [...definition.fields.entries()]
    .map(([id, item]) => ({id, ...item}))
    .sort((first, second) => second.label.length - first.label.length)

  return candidates.find(item =>
    [item.id, item.label, ...(item.aliases || [])]
      .filter(Boolean)
      .some(alias => text.includes(normalizeText(alias)))
  ) || null
}

export function buildEntityMutationCapabilities() {
  return [...DEFINITIONS.values()].map(definition => ({
    entity: definition.id,
    singular: definition.singular,
    aliases: definition.aliases,
    fields: [...definition.fields.entries()].map(([id, item]) => ({
      id,
      label: item.label,
      type: item.type,
      nullable: item.nullable === true,
      relationEntity: item.relationEntity || null,
      aliases: item.aliases || [],
    })),
  }))
}

export function validateEntityMutationPlan(plan = {}) {
  if (plan?.operation !== 'update') {
    return {ok: false, reason: 'unsupported-operation'}
  }

  const definition = getEntityMutationDefinition(plan?.entity)
  if (!definition) return {ok: false, reason: 'unknown-entity'}

  const target = String(plan?.target || '').trim()
  if (!target) return {ok: false, reason: 'missing-target'}

  const changes = []
  for (const entry of Array.isArray(plan?.changes) ? plan.changes : []) {
    const fieldId = String(entry?.field || '').trim()
    const fieldDefinition = definition.fields.get(fieldId)
    if (!fieldDefinition) continue

    changes.push({
      field: fieldId,
      value: entry?.value ?? null,
    })
  }

  if (!changes.length) return {ok: false, reason: 'missing-changes'}

  return {
    ok: true,
    definition,
    plan: {
      type: 'entity-mutation-plan',
      operation: 'update',
      entity: definition.id,
      target,
      changes: changes.slice(0, 10),
      source: plan?.source || 'deterministic',
      confidence: Number.isFinite(Number(plan?.confidence))
        ? Math.max(0, Math.min(1, Number(plan.confidence)))
        : 1,
      sourceMessage: String(plan?.sourceMessage || '').trim(),
    },
  }
}
