# Step F5 — dettaglio nativo di un piano base

## Confine applicativo e contratto

`renewals_get_plan({plan})` risponde al dettaglio di un singolo piano base. `plan` è una stringa obbligatoria: ID stabile o nome normalizzato esatto. Schema stretto, `additionalProperties:false`, CRM/principal richiesti, capability `facile.renewals.read`, read/low. Tool terminale e stateless: nessuna seconda inferenza per formattare il dettaglio e nessun merge cross-tool.

Lista anagrafica, ricerca filtrata e dettaglio restano rispettivamente `renewals_list_entities`, `renewals_search_plans`, `renewals_get_plan`. Addon, ranking, confronto, aggregazione e ricerca per prezzo non appartengono al nuovo tool.

## Datasource verificato

L'adapter esistente `/catalog/query` espone l'entità `plans` con filtro backend sui piani base. Il modulo legge tutte le pagine per risolvere ID/nome e proietta immediatamente i candidati; poi interroga `operation:detail` con filtro ID esatto e limite 1. I 199 payload completi non entrano nel modelContent.

Inventario reale: 199 piani base, 36 con `missingPrice:true`, 87 con più price entries, 112 con più risorse. Confermati i sei gruppi di nomi duplicati F3. Verificati lookup per ID di `DomAssLicBase`, `Admin Simple`, `DomProf150 NoSSL`, `ArubaDom-info`; lookup degli addon escluso.

| Campo reale | Significato/proiezione F5 |
|---|---|
| `id`, `name`, `supplier` | Identità del piano e riferimento fornitore compatto |
| `description` | Testo opzionale, non inventato quando nullo |
| `duration` | Durata in mesi secondo il contratto applicativo esistente (`entityMutationRegistry`, alias durata in mesi); valori reali 12 o null, proiettati in `durationMonths` |
| `activationFee` | `activation_fee`, tutto nullo nel catalogo verificato; escluso dal risultato F5 |
| `resources` | Join con resource ID/nome/category/unit e quantità `amount`; esclusi `key` e `addonStrategy` |
| `resourceNames` | Derivato ridondante da resources, escluso |
| `servicesTypesIn`, `servicesTypesOut` | Riferimenti ai tipi di servizio associati, normalizzati in `serviceTypesIn/Out`, solo ID/nome |
| `serviceTypeInNames`, `serviceTypeOutNames` | Derivati ridondanti, esclusi |
| `priceEntries` | Righe `plans_prices`, ciascuna con ID, importo nullable e riferimento alla versione di listino |
| `prices`, `priceListVersionNames` | Derivati da priceEntries che perdono associazioni/provenienza; esclusi |
| `missingPrice` | Vero quando non esistono righe o tutte hanno importo nullo; coerenza verificata prima di restituire il dettaglio |

## Pricing

`pricing:{missing,entries:[{id?,amount?,priceListVersion?:{id?,name,version?}}]}` conserva la relazione tra riga, importo e versione di listino. Importi nulli non diventano zero; un importo realmente zero resta zero. Nessun campo price unico, selezione del listino del cliente, sconto, IVA, conversione valutaria o annualizzazione. La valuta non è un campo del payload catalogo, quindi non viene aggiunta al contratto normalizzato.

- `DomAssLicBase`: 470 per Listino standard v1 e 438 per Listino Asilo Regina Margherita v4.
- `Admin Simple`: riga di Listino standard v1 con importo nullo; prezzo non disponibile, non zero.
- `DomProf150 NoSSL`: 719 per Listino Zilio Group Srl v3 e due righe Standard v1, una nulla e una 1350. Le righe non vengono fuse scegliendo arbitrariamente un valore.
- `ArubaDom-info`: quattro risorse con quantità zero e importo mancante; presenza della relazione non implica una quantità positiva.

L'ordinamento è deterministico; vengono eliminate solo proiezioni identiche. Righe con ID/importi differenti restano distinte. L'importo numerico è conservato e la formattazione non riduce una precisione superiore a due decimali.

## Risoluzione ed esiti

ID esatto ha precedenza sul nome. Nome: NFC, spazi compattati, confronto senza distinzione maiuscole/minuscole, senza fuzzy matching o sinonimi. Nessun risultato produce `type:clarification`, `code:NOT_FOUND`; nomi duplicati producono `code:AMBIGUOUS`, totale e candidati compatti ID/nome/fornitore. Nessun dettaglio viene letto o scelto arbitrariamente in caso di ambiguità. Il tool non cerca nella categoria addon.

Un catalogo parziale o incoerente fallisce esplicitamente. Contratti/dati invalidi, not found, ambiguità ed errori di esecuzione non introducono fallback legacy.

## Output e presentation

`renewals-plan` contiene ID/nome, fornitore/descrizione/durata opzionali, risorse compatte con quantità verificate, serviceTypesIn/Out e pricing. Limiti espliciti: 50 righe per relazione, descrizione 2000 caratteri, dettaglio normalizzato 24000 byte; oltre questi limiti fallisce senza presentare una proiezione troncata come completa.

La presentation usa una singola card con nome, fornitore, durata, risorse e tutte le voci di listino. La risposta dichiara la presenza di più voci e l'assenza di un prezzo unico applicabile. Quando manca il prezzo: «Prezzo non disponibile nel catalogo». Nessun null/undefined mostrato. Widget invariato.

## Follow-up e concorrenza

Il core Step C esistente espone lo snapshot; il nuovo tool può ricevere direttamente l'ID. Non sono aggiunte regole linguistiche per «quanto costa?» o per il cambio da lista/ricerca. Gli argomenti precedenti non vengono ereditati.

Gli unici hunk F5 in `tools.js` sono import e registrazione di `renewalsGetPlanTool`. Tutti i file concorrenti sono preservati. Catalog-list, ricerca F4, core agentico, routing, policy, provider e widget restano invariati. Nessuna nuova regex.

## Verifica

51 nuovi test dedicati coprono lookup, ambiguità senza scelta, normalizzazione, pricing multiplo/mancante, proiezioni compatte, presentation, schema/policy, ingressi POST e cambi tool senza merge. Le suite F1–F4, servizi, comunicazioni e proposal gate vengono eseguite insieme: 362/362 pass. `npm test`: 811 test, 793 pass e gli stessi 18 fallimenti della baseline (760/742/18): 16 aspettative del routing precedente, fixture keep_alive e intervallo temporale Send in Italy.

Ollama nativo `qwen3.5:4b` e vera POST `/api/chat` hanno verificato richieste dirette di dettaglio/risorse/prezzi, missingPrice, ambiguità, ricerca Aruba 9 → dettaglio Aruba-pecprem e lista 199 → dettaglio DomAssLicBase, senza fallback o toolErrors. Tutti i 199 payload reali vengono normalizzati correttamente; il modelContent di un singolo piano misura 459–2283 byte.

Limite osservato sul singleton: ricerca Logicom → un solo AnyDeskStd1y; «quanto costa?» seleziona get_plan ma Qwen passa il nome invece dell'ID `74a635ca-0224-4505-8d9b-f2bc276cb463` presente nello snapshot. Il nome identifica anche il piano Webcloud, quindi il tool restituisce correttamente AMBIGUOUS. La richiesta ellittica non è affidabile con Qwen 4B; nessun piano viene scelto arbitrariamente e nessuna modifica al core è stata introdotta per accomodarla. Il percorso con ID è coperto automaticamente e verificato sul datasource reale.

Regressioni native della POST: fornitori 18, resource types 15, piani base 199, Aruba 9, servizi Zilio Group 83 → 27 → 24, ultima comunicazione con destinatario/oggetto/modalità e saluto generale superati. Nessun `toolErrors` o fallback nei casi applicativi coperti. I log mostrano entrambe le fasi `model` e `tool`. Con sole credenziali CRM, la domanda sulle webcam offline produce `CAPABILITY_NOT_MIGRATED` e ingresso legacy, ma chiede chiarimento: non è una verifica funzionale di WebcamGo, la cui credenziale non è disponibile in questa prova.

Richieste fuori scope osservate, senza implementare nuove funzioni:

| Richiesta | Comportamento reale Qwen 4B |
|---|---|
| Piano più economico | Tenta search_plans senza fornitore, poi lista; esito ERROR con TOOL_VALIDATION_ERROR, nessun ranking o fallback |
| Confronto DomAssLicBase/Aruba-pecprem | Seleziona impropriamente get_plan per il primo piano; restituisce soltanto il suo dettaglio, senza confronto |
| Qual è il migliore? | Conversazione generale: chiede requisiti, nessun piano consigliato |
| Piano con più risorse | Restituisce la lista anagrafica, senza conteggio/ranking |

Quindi la selezione nativa per domande escluse non è affidabile, in particolare il confronto non resta sempre fuori da get_plan. Questo è un limite aperto osservato, non un test superato. Il contratto del tool resta mono-piano e la descrizione esclude esplicitamente tali richieste; F5 non introduce interpretazione linguistica, regex o modifiche al core per intercettarle.

Dopo il riavvio dell'API con il codice finale, vera POST con l'ID Logicom sopra → dettaglio Logicom corretto, nessun fallback/toolErrors; nome `F5-PianoInesistente-2026` → NOT_FOUND strutturato, nessun fallback/toolErrors. Ulteriore richiesta «Elenca gli addon del catalogo Rinnovi»: Qwen sceglie impropriamente la lista dei piani base invece del controllo di migrazione. Il lookup F5 di un ID addon è NOT_FOUND sul datasource reale, ma la selezione linguistica di addon verso il vecchio tool di lista rimane un problema aperto del modello; nessuna capability addon è stata aggiunta.

La richiesta di controllo «Quali gruppi clienti sono presenti nel catalogo Rinnovi?» seleziona anch'essa impropriamente list_entities(supplier), senza CAPABILITY_NOT_MIGRATED. Il meccanismo di migrazione è coperto dalle suite esistenti e osservato nella domanda sulle webcam, ma i due ingressi CRM addon/gruppi non superano la verifica nativa di selezione. Non vengono dichiarati regressioni preesistenti: non è stato eseguito un confronto nativo prima/dopo F5 con questi prompt. Le limitazioni restano esplicite e non vengono mascherate aggiungendo regole nel core.

## Proposta F6, non implementata

Definire il contratto di chiarimento per risorse e riferimenti a candidati ambigui, con selezione tramite ID verificato. Ranking e confronto richiedono capability separate, con listino/versione e significato commerciale espliciti.
