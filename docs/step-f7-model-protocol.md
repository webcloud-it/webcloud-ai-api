# Step F7 — separazione dei namespace model-facing

F7 rimuove gli ID capability dalla proiezione del control e lascia il namespace eseguibile al registry. WebcamGo passa con entrambi i modelli; le richieste native e la conversazione generale passano con il modello permanente 4B. La prova aggiuntiva MX del 9B resta NON conforme; la sua baseline F6 è scaduta, quindi non è possibile escludere una regressione F7 per quel caso.

## Causa e protocollo precedente

Il control tool `agent_report_outcome` richiedeva `capabilityIds`. La sua descrizione includeva il catalogo tecnico con oggetti `{id, description, nativeTools}` e lo schema enumerava ID come `facile.webcamgo.read`. Questi ID non erano function definitions, ma la vicinanza a nomi di funzioni e l'obbligo di copiarli negli argomenti avevano reso ambigua la proiezione per il 4B. Il namespace eseguibile del backend era già chiuso: l'ID invocato come funzione produceva TOOL_UNAVAILABLE, mai un'esecuzione.

Il successivo AGENT_MIGRATION_CONFLICT era intenzionale: dopo un errore, il control outcome non può aprire legacy. Anche dopo esecuzioni applicative riuscite la migrazione è vietata. F7 mantiene entrambi i gate.

I nomi business provengono da `getRegisteredTools`, sono filtrati da policy/principal/credenziale e diventano function definitions. Il control tool core è riservato e aggiunto separatamente. Lo state planner vede nomi e descrizioni dei soli tool autorizzati; history e snapshot dei tool nativi mantengono il contratto precedente, compresi i moduleId dello stato. Non viene aggiunto un planner.

## Protocollo finale

- CALLABLE TOOLS: function definitions dei business tool registrati e autorizzati, più il solo control tool core. Il riepilogo callable nella descrizione del control è derivato dal registry, senza join con ID del Capability Catalog.
- NON CALLABLE: aree legacy con etichette umane e sole descrizioni degli scope disponibili. Nessun capabilityId o moduleId tecnico del catalogo viene proiettato nel control schema/description. L'etichetta è soltanto un valore enumerato di `legacyAreas`.
- Il system prompt conserva le istruzioni generali e native; cambia soltanto il campo di migrazione da capabilityIds a legacyAreas e la terminologia corrispondente.

```json
{"outcome":"CAPABILITY_NOT_MIGRATED","legacyAreas":["WebcamGo"]}
```

```json
{"outcome":"GENERAL_CONVERSATION","reply":"Risposta completa alla domanda dell’utente."}
```

Schema: object, outcome richiesto; enum GENERAL_CONVERSATION / CAPABILITY_NOT_MIGRATED, reply string opzionale, legacyAreas array opzionale con 1–4 etichette enumerabili, additionalProperties=false. La validazione dei rami richiede reply non vuota e nessuna legacyAreas per GENERAL_CONVERSATION; legacyAreas non vuota e nessuna reply per CAPABILITY_NOT_MIGRATED. Senza aree autorizzate, il secondo outcome e legacyAreas non sono esposti. Il vecchio campo capabilityIds, un moduleId fornito dal modello e ID tecnici usati come etichette sono rifiutati.

## Mapping e autorizzazione backend

| Etichetta | Modulo interno |
|---|---|
| Rinnovi e CRM | facile.renewals |
| WebcamGo | facile.webcamgo |
| Send in Italy | facile.sendinitaly |
| Asiago.it e CMS | facile.asiago |
| Orari e aperture dei minisiti | facile.businesshours |
| Strumenti Webcloud | facile.webcloud |

Il mapping deriva da buildCapabilitySummary e dal catalogo esistente. Sono ammesse soltanto aree nello scope richiesto, con almeno una capability credenzialmente disponibile, principal autenticato e adapter chat realmente registrato. Gli ID delle capability disponibili vengono conservati nel record backend dell'area, senza esporli al modello. Al consumo del control outcome vengono ricontrollati adapter, catalogo, credenziali e coerenza del principal CRM. Credenziali aggiunte in seguito non ampliano lo scope già proiettato; credenziali rimosse impediscono il fallback.

Un modulo può avere più credenziali: il bollettino neve Asiago usa snowbulletin senza richiedere anche CMS. Vengono proiettate soltanto le descrizioni e permission effettivamente disponibili. Gli adapter esistenti continuano a verificare la credenziale dell'operazione concreta. Gli ID capability nei meta descrivono lo scope backend risolto, non operazioni eseguite né autorizzazioni dichiarate dal modello.

Per una sola area la POST usa direttamente il modulo validato, senza una seconda scelta linguistica. Per più aree conserva l'adapter multi-module esistente, vincolato ai moduleIds validati. I meta e l'audit riportano agentOutcome e fallbackModuleId per il caso singolo; moduleIds rimane disponibile per il caso multi-area. Nessun nuovo router o regex.

## Protezioni e test automatici

Preservati read/low, JSON e schema strict, credential/principal/capability dei business tool, proposal/confirmation Step B, state/refine/replace/switch Step C, agent-first Step E e l'intero contratto di esecuzione F6. Control esclusivo nei batch; nessun fallback dopo TOOL_UNAVAILABLE generico, altri errori o esecuzioni applicative. Nessun parsing del testo libero: un modello senza tool call produce AGENT_OUTCOME_REQUIRED.

Baseline prima di F7: 841 test, 823 passati e 18 fallimenti. Finale: 855 test, 837 passati e gli stessi 18 fallimenti, confrontati per nome (routing precedente, fixture keep_alive, intervallo temporale Send in Italy). Nessun nuovo fallimento; tutti i 14 nuovi test F7 passano. Suite mirata agent-first, agent-batch, agent-conversation, proposal-gate e catalog/plan F1–F5: 353/353.

I test verificano registry-only callable, assenza di ID tecnici nella proiezione, schema strict, mapping valido/inventato/non disponibile, credenziali e principal ricontrollati, scope multiper-credenziale senza espansione, adapter richiesto, nessun fallback opportunistico, general conversation, native business invariati e guard byte-per-byte delle parti F6/state/policy/provider protette. Le tre invarianti storiche F1/F4/F5 escludono ora soltanto i file autorizzati da F7; non vengono saltati test né disabilitate validazioni.

## Verifica della regressione durante lo sviluppo

Una prima proiezione che aggiungeva le aree legacy al system context superava WebcamGo e le richieste native ma faceva rispondere liberamente i due modelli al caso MX. Il backend rifiutava correttamente il testo con AGENT_OUTCOME_REQUIRED. Replay 4B del codice originale F6: GENERAL_CONVERSATION valido, 102 token. Prima proiezione F7: testo libero completo, 192 token, doneReason=stop; non era timeout o troncatura.

La sola aggiunta di un elenco callable al system context non bastava. La proiezione finale mantiene i due namespace nella descrizione/argomenti del control tool e conserva il system context precedente; replay 4B finale: GENERAL_CONVERSATION valido, 91 token. Nessuna istruzione specifica MX/WebcamGo, blacklist, aumento num_predict, accettazione del testo libero o rilassamento del fallback. Le prove diagnostiche non sono dichiarate prove POST finali.

## POST reali finali e casi esplorativi

| Caso | qwen3.5:4b | qwen3.5:9b |
|---|---|---|
| Webcam offline | agent_report_outcome → CAPABILITY_NOT_MIGRATED; 30 offline / 70, fallback reale facile.webcamgo; corretto; 89,470 s | agent_report_outcome → CAPABILITY_NOT_MIGRATED; 30 offline / 70, fallback reale facile.webcamgo; corretto; 210,789 s |
| Ultima comunicazione | renewals_search_communications → HANDLED; latest:true, ultima comunicazione verificata, nessun legacy; corretto; 32,643 s | renewals_search_communications → HANDLED; latest:true, ultima comunicazione verificata, nessun legacy; corretto; 44,191 s |
| Servizi Zilio Group | renewals_search_services → HANDLED; 83 servizi, nessun legacy; corretto; 32,672 s | renewals_search_services → HANDLED; 83 servizi, nessun legacy; corretto; 45,299 s |
| Spiegazione record MX | agent_report_outcome → HANDLED; GENERAL_CONVERSATION, risposta MX corretta, nessun legacy; corretto; 74,714 s | nessuna tool call → ERROR; AGENT_OUTCOME_REQUIRED, nessun legacy; NON corretto; 137,236 s |
| Gruppi (esplorativo) | renewals_list_entities → HANDLED; supplier, 18 fornitori invece dei gruppi; NON corretto; 45,436 s | renewals_list_entities → HANDLED; supplier, 18 fornitori invece dei gruppi; NON corretto; 43,258 s |
| Piano più economico (esplorativo) | renewals_list_entities → HANDLED; plan, lista di 199 piani senza ranking/aggregazione; NON corretto; 38,912 s | renewals_list_entities → HANDLED; plan, lista di 199 piani senza ranking/aggregazione; NON corretto; 49,910 s |
| Piano con più risorse (esplorativo) | renewals_list_entities → HANDLED; plan, lista di 199 piani senza ranking/aggregazione; NON corretto; 38,850 s | renewals_list_entities → HANDLED; plan, lista di 199 piani senza ranking/aggregazione; NON corretto; 50,237 s |

Tutti i casi WebcamGo/native risultano senza toolErrors; il solo errore della matrice finale è AGENT_OUTCOME_REQUIRED nella spiegazione MX del 9B. I tre casi esplorativi per modello non hanno toolErrors ma sono semanticamente non corretti: HTTP 200 / HANDLED non basta.

Metodo: POST reale /api/chat, middleware auth reale, Ollama nativo e backend CRM/WebcamGo reali. Modelli già disponibili, nessun download. Una sequenza seriale di sette chat nuove per modello; cache di sola lettura condivisa per congelare le risposte dei backend tra i modelli. Stesso codice, prompt, tools, contratti e configurazione, salvo il nome del modello. Temperatura 0, thinking false, contesto 4096, keep_alive permanente invariato; timeout chat temporaneo 300 s, timeout permanente 120 s e router 60 s invariati. I tempi sono descrittivi e non costituiscono una prova di compatibilità col timeout operativo corrente.

I casi esplorativi sono osservazioni e non hanno motivato correzioni business, schema, ranking, gruppi, aggregazioni o planner. Un successo su una richiesta WebcamGo per modello non è una garanzia statistica per tutte le richieste: un modello può ancora scegliere semanticamente un'area errata o inventare una funzione; il backend mantiene il rifiuto e non converte errori in fallback.

## File e confini

- agentOutcome.js: proiezione dei namespace, schema e mapping/scope backend.
- globalConversation.js: principal al control, nuovo nome del campo di migrazione, fallbackModuleId.
- routes/chat.js: selezione deterministica dell'adapter singolo già validato e propagazione osservabilità.
- observability/chatAudit.js: fallbackModuleId.
- agent-first.test.js: fixture e 14 test F7; agent-batch.test.js: sola fixture del control e guard invarianti F6.
- proposal-gate.test.js, renewals-catalog-entities.test.js, renewals-plan-search.test.js, renewals-plan-detail.test.js: fixture/guard adeguati al contratto autorizzato, business behavior invariato.
- Questo documento.

Non modificati business tools F1–F5, schemas servizi, capability catalog, globalChat/router linguistico, agentState, proposalGate, toolContract, ollamaProvider, widget, CRM API, configurazioni e .env. Nessun commit o push durante F7.

## Limiti e problemi aperti

La configurazione permanente usa qwen3.5:4b. I cinque controlli reali richiesti passano: WebcamGo 4B, WebcamGo 9B, communications 4B, Zilio 4B, conversazione generale 4B. Le verifiche aggiuntive native 9B passano, ma quella generale 9B non produce una tool call. Un replay del protocollo originale F6 con 9B, stessi tool/configurazione e presenza delle medesime credenziali rappresentata da fixture (nessun business execute), termina dopo 300 s con AGENT_PROVIDER_ERROR prima di ottenere la risposta modello. **Il comportamento generale 9B resta NON conforme; non è possibile stabilire con questa baseline se sia preesistente o una regressione F7.** Non viene classificato come successo né compensato con parsing del testo, fallback o prompt per il caso MX.

Il 9B impiega 210,789 s per WebcamGo; la fase modello stessa supera il timeout permanente di 120 s. Non è una verifica di compatibilità operativa con quel timeout. Ranking, gruppi e aggregazioni restano errori di riconoscimento delle capability non migrate; negazione 9B, singleton, comparison e altre ottimizzazioni non vengono corretti o ripetuti qui.

La matrice finale usa identici hash di system prompt, tool definitions e opzioni tra i modelli per ogni caso; sola presenza di credenziali CRM/WebcamGo, come nel supplemento del benchmark. Il payload della POST MX 4B coincide anche con quello del replay del protocollo finale verificato. Nessuna modifica ai file durante la matrice; HEAD e .env invariati, index vuoto.

Credenziale WebcamGo soltanto in memoria via stdin del processo temporaneo con echo disabilitato; mai salvata in script, .env, repository o report. 56 artefatti temporanei controllati: nessuna credenziale rilevata; nessun valore rilevato nei log catturati. Gli alberi di processi API/Ollama temporanei risultano chiusi. Le prove diagnostiche successive usano soltanto fixture, sono anch'esse concluse e non riutilizzano la credenziale WebcamGo. Nessun commit o push.
