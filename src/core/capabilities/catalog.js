const CAPABILITIES = [
  {
    id: 'facile.renewals.read',
    version: 1,
    moduleId: 'facile.renewals',
    domain: 'renewals',
    credential: 'crm',
    mode: 'read',
    risk: 'low',
    title: 'Consultazione rinnovi e CRM',
    description:
      'Riepiloghi, ricerche, liste, dettagli, scadenze, criticità, spazio, clienti, gruppi, fornitori, piani e comunicazioni.',
  },
  {
    id: 'facile.renewals.preview',
    version: 1,
    moduleId: 'facile.renewals',
    domain: 'renewals',
    credential: 'crm',
    mode: 'preview',
    risk: 'medium',
    title: 'Anteprime operazioni rinnovi',
    description:
      'Prepara anteprime deterministiche di modifiche, rinnovi cliente, rinnovi fornitore e rinnovi completi.',
  },
  {
    id: 'facile.renewals.mutate',
    version: 1,
    moduleId: 'facile.renewals',
    domain: 'renewals',
    credential: 'crm',
    mode: 'write',
    risk: 'high',
    confirmation: 'required',
    title: 'Operazioni sui rinnovi',
    description:
      'Esegue operazioni già proposte, con conferma esplicita, controllo dello stato e verifica successiva.',
  },
  {
    id: 'facile.renewals.navigate',
    version: 1,
    moduleId: 'facile.renewals',
    domain: 'renewals',
    credential: 'crm',
    mode: 'client-action',
    risk: 'low',
    title: 'Azioni nell’interfaccia rinnovi',
    description: 'Apre pannelli e prepara contenuti nell’interfaccia Facile senza salvarli automaticamente.',
  },
  {
    id: 'facile.webcamgo.read',
    version: 1,
    moduleId: 'facile.webcamgo',
    domain: 'webcamgo',
    credential: 'webcamgo',
    mode: 'read',
    risk: 'low',
    title: 'Consultazione WebcamGo',
    description:
      'Riepilogo, ricerca, stato, connettività, monitoraggio, hardware, downtime e dettagli delle webcam.',
  },
  {
    id: 'facile.webcamgo.control',
    version: 1,
    moduleId: 'facile.webcamgo',
    domain: 'webcamgo',
    credential: 'webcamgo',
    mode: 'write',
    risk: 'high',
    confirmation: 'required',
    title: 'Controllo sicuro WebcamGo',
    description: 'Prepara e conferma operazioni tecniche sulle webcam, inclusi riavvio controllato e movimento verso preset PTZ.',
  },
  {
    id: 'facile.sendinitaly.read',
    version: 1,
    moduleId: 'facile.sendinitaly',
    domain: 'sendinitaly',
    credential: 'specialk',
    mode: 'read',
    risk: 'low',
    title: 'Consultazione Send in Italy',
    description: 'Campagne, stato degli invii, statistiche, utenti, piani e utilizzo della piattaforma.',
  },
  {
    id: 'facile.businesshours.read',
    version: 1,
    moduleId: 'facile.businesshours',
    domain: 'businesshours',
    credential: 'cmsAsiagoIt',
    mode: 'read',
    risk: 'low',
    title: 'Orari e aperture dei minisiti',
    description: 'Stato corrente, prossimi cambi e calendario degli orari configurati nei minisiti.',
  },
]

function hasCredential(credentials = {}, key) {
  return Boolean(key && credentials?.[key])
}

export function getCapabilityCatalog({credentials = {}, includeUnavailable = false} = {}) {
  return CAPABILITIES.filter(capability => {
    return includeUnavailable || hasCredential(credentials, capability.credential)
  }).map(capability => ({
    ...capability,
    available: hasCredential(credentials, capability.credential),
  }))
}

export function getAvailableModuleIds(options = {}) {
  return [...new Set(getCapabilityCatalog(options).map(capability => capability.moduleId))]
}

export function getCredentialForModule(moduleId) {
  return CAPABILITIES.find(capability => capability.moduleId === moduleId)?.credential || null
}

export function buildCapabilitySummary(options = {}) {
  const capabilities = getCapabilityCatalog(options)
  const grouped = new Map()

  for (const capability of capabilities) {
    const group = grouped.get(capability.moduleId) || {
      moduleId: capability.moduleId,
      title:
        capability.domain === 'renewals'
          ? 'Rinnovi e CRM'
          : capability.domain === 'webcamgo'
            ? 'WebcamGo'
            : capability.domain === 'sendinitaly'
              ? 'Send in Italy'
              : 'Orari e aperture dei minisiti',
      descriptions: [],
    }

    group.descriptions.push(capability.description)
    grouped.set(capability.moduleId, group)
  }

  return [...grouped.values()]
}
