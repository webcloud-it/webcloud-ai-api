# Pubblicazione del chatbot Facile

## Architettura consigliata

La prima release usa due servizi distinti sulla stessa rete privata:

1. `webcloud-ai-api`, esposto tramite HTTPS;
2. `ollama`, non esposto pubblicamente, con volume persistente per i modelli.

`webcloud-ai-api` chiama `http://ollama:11434`. Il browser Facile non deve mai
contattare Ollama direttamente. Questa separazione consente di aggiornare e
scalare il gateway senza riscaricare il modello e impedisce di pubblicare
involontariamente l'API Ollama, che in modalità locale non richiede login.

Il file `deploy/compose.ollama.yml` documenta lo stack completo. In EasyPanel è
preferibile creare gli stessi tre workload:

- servizio persistente `ollama` dall'immagine ufficiale `ollama/ollama`;
- job una tantum `ollama pull qwen3.5:9b` dopo l'avvio o dopo il cambio modello;
- servizio applicativo costruito dal `Dockerfile` del repository.

Il volume `/root/.ollama` deve essere persistente. La porta `11434` deve restare
interna alla rete EasyPanel. Solo la porta HTTPS dell'AI API va pubblicata.

## Modello della prima release

Il modello operativo attualmente configurato è `qwen3.5:9b`.
Il download Ollama è circa 5,2 GB. È una scelta adeguata per routing semantico,
estrazione di intenti e generazione di bozze in italiano senza servizi a
pagamento.

Per un host soltanto CPU è possibile partire con lo stesso modello, accettando
latenze superiori. Per un uso interattivo multiutente è consigliata una GPU con
memoria sufficiente a mantenere il modello caricato. La decisione CPU/GPU va
presa dopo un test di carico sul server EasyPanel reale.

Documentazione ufficiale:

- https://docs.ollama.com/docker
- https://docs.ollama.com/api/authentication
- https://ollama.com/library/qwen3.5:9b

## Variabili richieste

```dotenv
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://facile.webcloud.it

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_CHAT_MODEL=qwen3.5:9b
OLLAMA_REQUIRED=true
OLLAMA_TIMEOUT_MS=45000
OLLAMA_ROUTER_TIMEOUT_MS=15000
OLLAMA_THINK=false
OLLAMA_KEEP_ALIVE=10m

CRM_DIRECTUS_BASE_URL=https://crm.webcloud.cloud
CRM_TOKEN=<segreto server-side>
AI_ALLOWED_CRM_ROLE_IDS=<uuid-ruolo-admin>,<uuid-ruolo-operatore>
RENEWALS_API_BASE_URL=https://crm-renewals-api.webcloud.cloud
SENDINITALY_API_BASE_URL=https://api.sendinitaly.com/v1
SENDINITALY_SUPPORT_API_BASE_URL=https://api-dev.sendinitaly.com/v1
BUSINESS_HOURS_API_BASE_URL=https://business-hours-api.webcloud.cloud/v1
```

Vanno inoltre configurate le altre variabili presenti in `.env.template`, senza
commettere valori reali. `OLLAMA_API_KEY` resta vuota per l'istanza locale
privata; è prevista soltanto per provider remoti compatibili.

## Controlli di deploy

- `GET /health` verifica che il processo Node sia vivo.
- `GET /ready` verifica Ollama e la presenza esatta del modello configurato.
- Con `OLLAMA_REQUIRED=true`, `/ready` restituisce `503` finché il modello non è
  utilizzabile.
- Il token CRM inviato da Facile viene verificato su Directus prima che il
  gateway possa usare le credenziali server-side dei rinnovi.
- `AI_ALLOWED_CRM_ROLE_IDS` limita tale possibilità ai ruoli Directus
  esplicitamente autorizzati; in produzione non va lasciato vuoto.
- In produzione CORS deve contenere esclusivamente le origini Facile ammesse.

Ordine di rilascio:

1. avviare Ollama e montare il volume persistente;
2. eseguire `ollama pull qwen3.5:9b`;
3. pubblicare l'AI API con `OLLAMA_REQUIRED=true`;
4. verificare `/health` e `/ready`;
5. pubblicare widget e integrazione Facile;
6. eseguire smoke test su letture, disambiguazione e una proposta con conferma,
   senza confermare operazioni reali durante il collaudo.

## Debito tecnico approvato — Step C (5 ottobre 2026)

Il protocollo `refine/replace/switch` aggiunge una chiamata LLM prima della native
tool call sui turni con stato. Questo costo resta accettato come debito tecnico;
non viene ottimizzato nello Step D. Gli step successivi non devono aggiungere
altri planner LLM intermedi. Il limite complessivo resta quattro chiamate modello.

## Protocollo proposte — Step B (5 ottobre 2026)

`POST /api/chat` gestisce le decisioni prima del routing e dell'agente. Soltanto
anteprime realmente emesse dal backend vengono associate al principal autenticato,
alla sessione e alla credenziale del modulo. History e `principal` nel body non
autorizzano operazioni. Il backend sceglie l'ultima proposta della sessione; una
nuova proposta sostituisce quella precedente anche se appartiene a un altro modulo.

Restano compatibili i pulsanti testuali `confermo` / `annulla` e il payload legacy
`action: {actionId, decision: "confirm" | "cancel"}`. Il contratto strutturato è:
`action: {type: "proposal-confirm" | "proposal-cancel", proposalId}`.
L'identificatore è `data.action.actionId` per rinnovi/catalogo, oppure il
`data.proposalToken` già presente nei payload WebcamGo/assistenza. Le card rinnovi
includono l'azione strutturata come metadato aggiuntivo; il widget attuale resta
testuale. I token opachi non vengono copiati nella presentation.

Owner, sessione, credenziale, scadenza e stato pendente vengono verificati prima
dell'esecuzione. La proposta viene acquisita prima di ogni `await`; replay,
annullamento e doppie conferme concorrenti non rieseguono la mutazione. Gli
adapter mantengono i controlli sullo stato atteso e i rinnovi/catalogo mantengono
la verifica post-operazione. Gli errori non entrano nell'agente o nel fallback.

L'indice resta in memoria, come gli store applicativi: riavvii richiedono nuove
anteprime; più processi richiederebbero uno store condiviso con acquisizione
atomica. Le decisioni finalizzate/scadute restano riconoscibili per 30 minuti dopo
la scadenza. Non esiste un ID chat server-side: la precedenza è per sessione
autenticata. Un client futuro deve usare l'azione strutturata per rifiutare il
click su una card superata. Nessun write tool agentico viene aggiunto.

## Agent-first e adapter legacy — Step E (5 ottobre 2026)

Il percorso della POST è auth → proposalGate → executeAgentRequest →
presentation/audit. Globale ed esplicito usano lo stesso orchestrator; il modulo
esplicito limita il registry mediante ID, mai mediante il testo della richiesta.
Il registry validato e la policy Step A definiscono i tool nativi autorizzati.
Registrare un ulteriore tool conforme lo rende visibile senza regole linguistiche.

Il confine restituisce `{outcome, response}`. Gli outcome sono HANDLED (tool o
conversazione generale), CAPABILITY_NOT_MIGRATED (unico ingresso legacy), ERROR
(contratto, provider, policy, autorizzazione, esecuzione, stato o limite passaggi).
Una risposta conversazionale strutturata è HANDLED; testo fuori protocollo o
una risposta vuota sono ERROR. Errori
precedenti restano ERROR anche se il modello corregge la chiamata successiva.

Il control tool interno `agent_report_outcome` viene esposto nella medesima
inferenza dei tool nativi. GENERAL_CONVERSATION richiede reply e nessuna
capability; CAPABILITY_NOT_MIGRATED richiede capabilityIds e nessuna reply.
La risposta generale è prodotta dall'LLM nello stesso segnale, senza executor
applicativi, legacy o inferenze aggiuntive. Non è registrato come tool
applicativo e non esegue dati/azioni. Enum e descrizioni provengono dal catalogo
backend filtrato per credenziali e scope esplicito, senza esporre adapter
indisponibili. Il backend valida schema, scope, principal e credenziali. Non sono
ammesse decisioni miste con altri tool o segnali dopo esecuzioni/errori. Nessuna
frase magica, regex o inferenza preliminare viene aggiunta. La scelta semantica
della copertura resta responsabilità del modello, osservabile nei meta.

Solo dopo questo segnale si usa globalChat per localizzare un adapter temporaneo.
Il router non può espandere i moduli autorizzati dal segnale. Se non riconosce la
frase, il modulo strutturato individua comunque l'handler; richieste multi-area
non localizzabili richiedono chiarimento. Il multi-module legacy resta disponibile
con gli stessi controlli read-only: l'agente segnala tutte le capability prima
di eseguire tool se una parte non è migrata. In futuro più tool nativi potranno
sostituire questi adapter senza cambiare il router. Non si redesignano ora le
risposte terminali multi-tool.

Il budget principale conserva i 300 token della risposta conversazionale; le
domande semplici richiedono poche frasi complete. Non si cambia il timeout o
il provider. Le prove reali iniziali hanno esposto risposte troncate/timeout
e richieste interne trattate come testo conversazionale: il protocollo richiede
ora un esito strutturato per non dedurre l'intento dalla sola assenza di tool.

I meta e l'audit esistente espongono agentAttempted, agentHandled, agentOutcome,
generalConversation, legacyFallback e fallbackReason; il fallback usa
`routingSource: agent`, `fallbackReason: capability-not-migrated` e conserva
legacyRoutingSource. Le metriche Ollama/tempi restano agentTimings. Non vengono
aggiunti log di token, identità, frasi o contenuti delle comunicazioni.

Step A/B/C/D restano attivi. Il planner di stato C usa ancora una chiamata quando
esiste uno snapshot e rimane debito tecnico; il limite complessivo è quattro.
I test B adattano solo il provider simulato per creare anteprime attraverso il
segnale di migrazione; stores, executor e verifiche B restano quelli reali.
I due vecchi assert sul ritorno null dell'agente sono sostituiti dal contratto
E esplicito. Le funzioni help/conversation/unsupported di globalChat restano
per compatibilità, ma non sono gate del percorso nativo.

Debiti residui: classificazione semantica del control signal affidata al modello;
granularità delle capability più ampia dei singoli tool (la copertura di ogni
richiesta non è dimostrabile solo dal capabilityId); adapter linguistici legacy
e future risposte multi-tool; latenza dello Step C; store proposte in memoria e
precedenza per sessione già documentati nello Step B. Nessun nuovo write tool.

La prova aggiuntiva "lista dei fornitori presenti" riproduce anche nel checkpoint
39a88a1 una selezione errata di renewals_search_services con limit oltre lo schema,
seguita da una ricerca servizi. Resta un debito di copertura semantica del modello;
Step E lo dichiara ERROR e non usa fallback per recuperarlo. Il fallback reale
verificato usa la capability esistente facile.webcloud.chat-audit.read.
