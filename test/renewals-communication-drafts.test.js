import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {
  buildCommunicationDraftPreview,
  handlePendingCommunicationDraftClarification,
  hasPendingCommunicationDraftClarification,
  parseCommunicationDraftRequest,
  planCommunicationDraftRequest,
  resolveCommunicationDraftTarget,
} from '../src/modules/facile/renewals/communicationDrafts.js'

function makeService(overrides = {}) {
  return {
    id: 'service-eco-pv',
    name: 'eco-pv.it',
    authCode: 'SEGRETO-DA-NON-MOSTRARE',
    domains_id: {id: 'domain-eco-pv', name: 'eco-pv.it'},
    customer: {
      id: 'customer-eco-pv',
      name: 'Consorzio Eco-Pv',
      group: {id: 'group-zilio', name: 'Zilio Group Srl'},
      contacts: [
        {
          id: 'contact-1',
          name: 'Mario Rossi',
          role: 'Amministrazione',
          items: [
            {id: 'contact-item-1', type: 'email', item: 'mario@example.it'},
            {id: 'contact-item-2', type: 'telefono', item: '+39 0444 000000'},
          ],
        },
        {
          id: 'contact-2',
          name: 'Ufficio',
          role: null,
          items: [
            {id: 'contact-item-3', type: 'altro', item: 'INFO@EXAMPLE.IT'},
            {id: 'contact-item-4', type: 'altro', item: 'mario@example.it'},
          ],
        },
      ],
    },
    subscriptions: [
      {
        id: 'subscription-customer',
        isSupplier: false,
        endsOn: '2027-02-13T12:00:00.000Z',
        plan: {
          id: 'plan-domprof',
          name: 'DomProf170 NoSSL',
          description: 'Hosting professionale',
          priceFinal: 784,
        },
        addons: [{id: 'addon-1', name: 'Backup'}],
      },
    ],
    pleskDomain: {
      statsDiskUsage: {
        totalSize: 90,
        quota: 100,
      },
    },
    ...overrides,
  }
}

const generateFn = async () =>
  JSON.stringify({
    subject: 'Rinnovo eco-pv.it',
    bodyText: 'Gentile Consorzio Eco-Pv,\n\nla contattiamo per il rinnovo di eco-pv.it.',
  })

describe('Planner bozze comunicazioni', () => {
  test('riconosce una bozza email di rinnovo', () => {
    const request = parseCommunicationDraftRequest(
      'prepara una bozza email di rinnovo per eco-pv.it'
    )

    assert.equal(request?.operation, 'draft')
    assert.equal(request?.purpose, 'renewal')
    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.equal(request?.requestedSend, false)
  })

  test('riconosce una bozza per upgrade spazio', () => {
    const request = parseCommunicationDraftRequest(
      'scrivi una mail per proporre un upgrade dello spazio di eco-pv.it'
    )

    assert.equal(request?.purpose, 'space-upgrade')
    assert.equal(request?.namedTarget, 'eco-pv.it')
  })

  test('non intercetta la lettura delle email già inviate', async () => {
    assert.equal(parseCommunicationDraftRequest('qual è l’ultima email inviata?'), null)
    assert.equal(
      await planCommunicationDraftRequest({
        message: 'qual è l’ultima email inviata?',
        allowSemantic: false,
      }),
      null
    )
  })

  test('il planner semantico restituisce soltanto un piano astratto', async () => {
    const request = await planCommunicationDraftRequest({
      message: 'mi servirebbe un testo da mandare per eco-pv.it',
      callLlm: async () =>
        JSON.stringify({
          operation: 'draft',
          purpose: 'generic',
          target: 'eco-pv.it',
          confidence: 0.96,
        }),
    })

    assert.equal(request?.operation, 'draft')
    assert.equal(request?.namedTarget, 'eco-pv.it')
    assert.equal(request?.source, 'semantic')
  })
})

describe('Risoluzione servizio della bozza', () => {
  test('risolve il servizio esatto', () => {
    const request = parseCommunicationDraftRequest('prepara una mail per eco-pv.it')
    const result = resolveCommunicationDraftTarget({
      request,
      services: [makeService()],
    })

    assert.equal(result.status, 'resolved')
    assert.equal(result.service.id, 'service-eco-pv')
  })

  test('non sceglie arbitrariamente tra servizi omonimi', () => {
    const request = parseCommunicationDraftRequest('prepara una mail per eco-pv.it')
    const result = resolveCommunicationDraftTarget({
      request,
      services: [
        makeService(),
        makeService({
          id: 'service-assistance',
          subscriptions: [
            {
              id: 'subscription-assistance',
              isSupplier: false,
              endsOn: '2027-03-03T12:00:00.000Z',
              plan: {id: 'plan-assistance', name: 'PacAssPrem'},
              addons: [],
            },
          ],
        }),
      ],
    })

    assert.equal(result.status, 'ambiguous')
    assert.equal(result.candidates.length, 2)
  })
})

describe('Anteprima bozza email', () => {
  test('mostra destinatari, oggetto e testo senza inviare', async () => {
    const request = parseCommunicationDraftRequest(
      'prepara una bozza email di rinnovo per eco-pv.it'
    )
    const result = await buildCommunicationDraftPreview({
      request,
      services: [makeService()],
      actorToken: 'draft-preview',
      generateFn,
    })

    assert.equal(result.intent, 'communication-draft')
    assert.equal(result.data.draft.previewOnly, true)
    assert.equal(result.data.draft.sendAllowed, false)
    assert.equal(result.data.draft.recipients.length, 2)
    assert.deepEqual(
      result.data.draft.recipients.map(item => item.email),
      ['mario@example.it', 'info@example.it']
    )
    assert.equal(result.data.draft.subject, 'Rinnovo eco-pv.it')
    assert.match(result.reply, /Nessun invio è stato eseguito/i)
    assert.doesNotMatch(JSON.stringify(result), /SEGRETO-DA-NON-MOSTRARE/)
  })

  test('segnala quando il cliente non ha email disponibili', async () => {
    const service = makeService({
      customer: {
        id: 'customer-no-email',
        name: 'Cliente senza email',
        contacts: [],
      },
    })
    const result = await buildCommunicationDraftPreview({
      request: parseCommunicationDraftRequest('prepara una mail per eco-pv.it'),
      services: [service],
      actorToken: 'draft-no-recipient',
      generateFn,
    })

    assert.deepEqual(result.data.draft.warnings, ['recipient-missing'])
    assert.match(result.reply, /nessun indirizzo email disponibile/i)
  })

  test('una richiesta prepara e invia produce soltanto la bozza', async () => {
    const request = parseCommunicationDraftRequest(
      'prepara e invia una email di rinnovo per eco-pv.it'
    )
    const result = await buildCommunicationDraftPreview({
      request,
      services: [makeService()],
      actorToken: 'draft-send-not-executed',
      generateFn,
    })

    assert.equal(result.data.draft.requestedSend, true)
    assert.equal(result.data.draft.sendAllowed, false)
    assert.ok(result.data.draft.warnings.includes('send-not-executed'))
    assert.match(result.reply, /non è stata spedita alcuna email/i)
  })
})

describe('Chiarimento servizio della bozza', () => {
  test('seleziona il secondo servizio e genera la bozza', async () => {
    const services = [
      makeService(),
      makeService({
        id: 'service-assistance',
        customer: {
          ...makeService().customer,
          contacts: [
            {
              id: 'contact-assistance',
              name: 'Amministrazione',
              items: [{id: 'email-assistance', item: 'assistenza@example.it', type: 'email'}],
            },
          ],
        },
        subscriptions: [
          {
            id: 'subscription-assistance',
            isSupplier: false,
            endsOn: '2027-03-03T12:00:00.000Z',
            plan: {id: 'plan-assistance', name: 'PacAssPrem'},
            addons: [],
          },
        ],
      }),
    ]
    const actorToken = 'draft-clarification'
    const first = await buildCommunicationDraftPreview({
      request: parseCommunicationDraftRequest(
        'prepara una bozza email di rinnovo per eco-pv.it'
      ),
      services,
      actorToken,
      generateFn,
    })

    assert.equal(first.intent, 'clarification')
    assert.equal(hasPendingCommunicationDraftClarification({actorToken}), true)

    const second = await handlePendingCommunicationDraftClarification({
      message: 'secondo',
      services,
      actorToken,
      generateFn,
    })

    assert.equal(second.intent, 'communication-draft')
    assert.equal(second.data.draft.target.id, 'service-assistance')
    assert.equal(second.data.draft.recipients[0].email, 'assistenza@example.it')
  })

  test('annulla il chiarimento senza inviare nulla', async () => {
    const services = [makeService(), makeService({id: 'service-2'})]
    const actorToken = 'draft-clarification-cancel'

    await buildCommunicationDraftPreview({
      request: parseCommunicationDraftRequest('prepara una mail per eco-pv.it'),
      services,
      actorToken,
      generateFn,
    })

    const result = await handlePendingCommunicationDraftClarification({
      message: 'annulla',
      services,
      actorToken,
      generateFn,
    })

    assert.equal(result.intent, 'communication-draft-cancelled')
    assert.match(result.reply, /Nessuna email è stata inviata/i)
  })
})
