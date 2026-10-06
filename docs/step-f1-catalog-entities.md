# Step F1 — catalogo rinnovi (6 ottobre 2026)

## Base e lavoro precedente

Base F1: `cad18b8`, successivo al checkpoint Step E `e5c2be2`.
All'inizio il working tree era pulito. I dieci file precedentemente estranei
sono già inclusi in cad18b8: separano cliente commerciale e operativo, mantengono
la compatibilità dei payload precedenti e rinviano la migrazione storica delle
comunicazioni alla fase 3. Non sono un tentativo di migrazione agentica F1.
F1 non modifica questi file, incluso il loro test dedicato. La provenienza è
confermata dalla chat "Aggiungere cliente commerciale", FASE 2. Nella stessa
chat è in corso FASE 3A: durante F1 sono apparse nuove modifiche relative
all'identità storica delle comunicazioni (communications, prompt,
readEntityRegistry, serviceDetails, nuovo communicationIdentity e parte di tools).
Quelle modifiche sono concorrenti, non appartengono a F1 e non sono ripristinate.
In tools.js F1 aggiunge soltanto l'import catalogEntities e la voce nel registry;
eventuali altre differenze nello stesso file appartengono alla FASE 3A.
Anche il nuovo test renewals-history-identity e le aggiunte in renewals-tools.test
sono comparse nella lavorazione concorrente e non sono modifiche F1.

Il readEntityRegistry precedente offre già record/analisi backend per molte
entità. I suoi record fornitori uniscono opzioni e riferimenti nei servizi;
piani/risorse derivati possono includere solo entità effettivamente referenziate.
È utile per quelle operazioni legacy ma non equivale al catalogo completo.
Non vengono importati planner linguistici, alias, filtri o aggregazioni legacy
nel nuovo contratto nativo.

## Inventario verificato tramite API applicativa reale

POST `/catalog/query` con operation=list, limit=1 e nessun filtro:

| Entità | ID API / collection | Totale verificato | Dati |
| --- | --- | ---: | --- |
| Fornitori | providers / suppliers | 18 | id, name |
| Piani base | plans / plans | 199 | id, name, tipo, supplier, risorse, prezzi |
| Tipi di risorsa | resources / resources | 15 | id, name, key, categoria, unità |
| Clienti | customers / customers | 87 | id, name, tipo, gruppo, listino |
| Gruppi | groups / customers_groups | 3 | id, name, listino |

L'endpoint dichiara source=catalog, sourceScope=complete-master-data.
I piani base hanno un filtro applicativo già esistente sui tipi base; gli addon
costituiscono una distinta entità API. I totali descrivono la prova, non costanti
nel codice. La lista fornitori include tutte le anagrafiche, anche senza servizi.

## Scelta e contratto

Scelta A: tool stabile di lista anagrafica, con una sola entità abilitata in F1.
Le cinque entità possono condividere una proiezione minima id/name e read/low;
relazioni, prezzi, gruppi e aggregazioni hanno semantiche ulteriori e non sono
esposte da questa lista. Nessun mini query language e nessuna migrazione generale.

`renewals_list_entities({entityType: "supplier", limit?: integer, offset?: integer})`

- entityType obbligatorio, enum contenente solo supplier;
- limit 1..50, default 50; offset >= 0, default 0;
- additionalProperties=false; nessun filtro/sort/aggregazione accettato;
- moduleId=facile.renewals, capabilityId=facile.renewals.read;
- credential=crm, requiresPrincipal=true, mode=read, risk=low;
- terminal=true, stateful=false.

L'esecuzione usa queryRenewalsCatalog del modulo rinnovi, con entity=providers,
operation=list, filters=[], ordinamento nome/ID e pagine da 50. L'LLM non conosce
collection Directus o URL e non accede al datasource direttamente.
Si leggono tutte le pagine prima della deduplica e della paginazione pubblica:
il total normalizzato è reale, sourceTotal indica il conteggio grezzo.
Le risposte incomplete/incoerenti e oltre 100 pagine falliscono esplicitamente;
nessun ripiego su servizi o su adapter legacy.

Normalizzazione backend: ID stabile prioritario; nomi NFC, spazi compattati e
confronto senza distinzione maiuscole per record senza ID. Un nome senza ID è
unito a un record identificato solo se indica un unico ID. ID distinti restano
distinti anche con nomi uguali. La label scelta e l'ordine sono deterministici,
indipendenti dall'ordine di ingresso. ID senza nome usa l'ID come label;
righe senza ID e senza nome sono omesse; gli ID mancanti non sono inventati.
Non si usa fuzzy matching.

Output: type=renewals-entity-list, entityType, entityLabel, source/sourceScope,
sourceTotal, total, shown, offset, limit, hasMore, nextOffset, items=[{id?, name}].
Reply e presentation sono backend: titolo/count e nomi di tutti i risultati
mostrati (massimo 50). Nessuna logica aggiunta al widget. La presentation usa
il contratto list esistente, con ID tecnici di card solo dove manca un ID dati.

## Stato e confini

Lo snapshot C descrive tool, entityType e metadati della lista; non trasforma
un campione di fornitori in conteggi servizi. "Quali hanno più servizi?" richiede
un'aggregazione che F1 non espone: il modello deve dichiarare una capability
non migrata per l'analisi. Un eventuale adapter legacy può calcolarla con le
operazioni backend esistenti. Nessun numero è derivato dal modello.

La nuova registrazione è sufficiente per renderla visibile all'agente globale
ed esplicito. routes/chat, globalConversation, globalChat, agentOutcome,
agentState, proposalGate, toolContract e ollamaProvider restano invariati.
F1 non modifica il datasource comunicazioni; le modifiche concorrenti FASE 3A
sono distinte dal perimetro di questo step. Nessun pattern linguistico aggiunto.

## Verifica

Il nuovo test attraversa POST /api/chat con auth, registry, policy, orchestrator,
provider HTTP simulato e datasource HTTP: valida lista, schema, mancata esecuzione
con argomenti non validi, autorizzazione, assenza di fallback ed errori executor.
Copre deduplica, ordine, ID/label, paginazione completa, empty/incomplete result,
presentation oltre dieci card e snapshot senza metriche inventate.
I test A/B/C/D/E vengono conservati; gli assert sul catalogo di esattamente due
tool diventano confronti con i tool registrati, senza rimuovere le altre verifiche.

Baseline npm test prima di F1: 655 test, 637 passati, 18 falliti. Per il confronto
si usa OLLAMA_BASE_URL=http://127.0.0.1:1 soltanto nel processo dei test isolati.
I fallimenti precedenti sono 16 aspettative del planner legacy, una configurazione
keep-alive Ollama e una fixture di intervallo temporale Send in Italy.
Non vengono corretti nel perimetro F1.

Risultato automatico F1: 29 nuovi test; suite mirata A/B/C/D/E/F1 e riferimenti
cliente 234/234. npm test: 684 test, 666 passati, gli stessi 18 fallimenti della
baseline, verificati confrontando i nomi (zero nuovi fallimenti).

Prove reali su POST /api/chat con qwen3.5:4b e CRM, chat nuova per ciascuna frase:
"lista dei fornitori presenti", "quali fornitori ci sono nei rinnovi?" e
"mostrami i fornitori" scelgono tutte renewals_list_entities, restituiscono
18 fornitori con ID/name e 18 card, HANDLED, zero toolErrors e zero fallback.
Il tool è scelto nella prima inferenza e i log contengono phase=model/tool.

Le altre prove reali preservano servizi 83 → 27 → 24, ultima comunicazione
con destinatario/oggetto/modalità verificati (384 comunicazioni nel datasource,
una mostrata), spiegazione MX senza executor e metriche chatbot tramite il
segnale CAPABILITY_NOT_MIGRATED/fallback esistente. Nove verifiche principali
riuscite; una prova aggiuntiva di classifica non soddisfatta, descritta sotto.
Log e JSON delle prove sono in TEMP, senza token né credenziali stampati.
I processi API e Ollama avviati per la verifica vengono chiusi al termine;
non viene eseguito commit, push, deploy o alcuna operazione write applicativa.

Limite reale del follow-up non obbligatorio: "quali hanno più servizi?" ha scelto
ancora la lista anagrafica e riproposto i 18 nomi senza inventare conteggi. Il
provider non ha emesso il segnale CAPABILITY_NOT_MIGRATED atteso per una classifica.
Il test automatico verifica che tale segnale esplicito e lo snapshot funzionino;
non dimostra che il provider reale lo selezioni in ogni caso. È un limite semantico
aperto, distinto dal caso minimo F1 riuscito. Non si aggiungono aggregazioni,
guardie linguistiche o modifiche core per inseguire quel follow-up in F1.

## F2 proposto, non implementato

Estendere l'enum della medesima lista soltanto a resourceType, poi plan, customer
e group, dopo verifica delle rispettive proiezioni, volumi e significato di
"presenti". Conservare il limite e gli esiti di incompletezza; per volumi elevati
valutare deduplica/paginazione applicativa invece di caricare tutta l'anagrafica.
Per piani occorre distinguere base/addon; per clienti la separazione commerciale/
operativa deve essere esplicita. Dettagli relazionali e classifiche/conteggi servizi
richiedono contratti dedicati e verificati. Nessun write incluso.
