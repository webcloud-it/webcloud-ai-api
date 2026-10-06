# Step F4 — ricerca nativa dei piani

## Contratto

`renewals_search_plans({supplier?, limit?, offset?})` è un confine applicativo distinto dalla lista anagrafica `renewals_list_entities` e dal futuro dettaglio `renewals_get_plan`.

- `supplier`: ID stabile oppure nome esatto. NFC, spazi compattati e confronto senza distinzione tra maiuscole/minuscole; nessuna rimozione di accenti, sinonimi o fuzzy matching.
- `limit`: intero 1–50, predefinito 50; `offset`: intero >= 0, predefinito 0.
- Nessun filtro restituisce una ricerca non filtrata; per la richiesta di lista anagrafica la definition invita il modello a usare `renewals_list_entities(plan)`.
- JSON Schema stretto, `additionalProperties:false`, read/low, principal CRM, credenziale CRM e capability `facile.renewals.read`.
- `stateful:true`: le successive paginazioni dello stesso tool possono conservare il fornitore. Il core Step C esistente impedisce il merge degli argomenti tra tool diversi.

## Datasource e risoluzione

L'adapter esistente interroga `/catalog/query`. Il modulo legge e verifica tutte le pagine dell'anagrafica `providers`; cerca prima l'ID e poi il nome normalizzato esatto. La ricerca piani invia al backend soltanto `supplier.id equals <ID>`, con ordinamento nome/ID. L'entità backend `plans` esclude gli addon.

Un nome inesistente, più ID con lo stesso nome o un fornitore privo di ID producono `data.type:clarification` con reason e candidati compatti quando disponibili, senza interrogare i piani né scegliere arbitrariamente. Un errore o un catalogo incompleto falliscono esplicitamente; nessun fallback legacy introdotto.

Il risultato `renewals-plans` contiene totale, paginazione, fornitore risolto opzionale e `items:{id,name,supplier?:{id?,name}}`. Il modulo riusa la proiezione compatta F3, ordinando prima della paginazione pubblica. Prezzi, risorse, listini e descrizioni non raggiungono il modelContent. La presentation mostra `Piani trovati: N` e card nome/fornitore.

Verifica reale del datasource: 18 fornitori, 199 piani base, 38 addon separati. Aruba: ID `437bd097-a0f4-4951-a5df-06ca8b94014b`, 9 piani base; filtro backend verificato contro la lista completa F3.

## Filtro resource rimandato

I resource ID dei piani corrispondono al catalogo di 15 tipi. Tuttavia `email` non è un nome esatto: può riferirsi a caselle di posta, spazio per casella, spazio per tutte le caselle oppure limiti/velocità di spedizione Send in Italy. F4 resta supplier-only. La risoluzione di questa ambiguità richiede un contratto di chiarimento successivo; nessun sinonimo o scelta implicita aggiunto.

Prezzi minimo/massimo, ordinamento per prezzo, piano più economico, maggior numero di risorse, ranking e dettaglio completo restano fuori dal contratto.

## Concorrenza

In `tools.js` gli unici hunk F4 sono l'import di `renewalsSearchPlansTool` e la sua registrazione. Comunicazioni, identità storica, scheduling e relativi test concorrenti restano invariati. Catalog-list, core agentico, routing, provider e widget non sono modificati.

## Verifica automatica

41 nuovi test F4 coprono ricerca, risoluzione, ambiguità, pagination, schema/policy, payload compatto, presentation, POST reale con provider/datasource fixture, switch e divieto di merge cross-tool, assenza di fallback su errori e integrità dei file protetti.

Suite mirata: 310/310 pass. `npm test`: 760 test, 742 pass e 18 fail, stessi fallimenti della baseline (719 test, 701 pass, 18 fail): 16 aspettative del routing precedente, una fixture `keep_alive` e una fixture temporale Send in Italy. Nessuna nuova regressione automatica.

La verifica con Ollama nativo `qwen3.5:4b`, CRM locale e vera POST `/api/chat` conferma:

- Lista piani → follow-up Aruba: `renewals_list_entities(plan)` → `renewals_search_plans(supplier:Aruba)`, 199 → 9, nessun `entityType` ereditato.
- Entrambe le richieste dirette su Aruba: nuovo tool, stessi 9 piani verificati per ID e fornitore.
- Liste anagrafiche: 18 fornitori, 15 tipi di risorsa, 199 piani base.
- Servizi Zilio Group: 83 → scadenze 2026: 27 → esclusione da non rinnovare: 24.
- Ultima comunicazione: tool nativo, destinatario/oggetto/modalità conservati.
- Tutti questi casi: nessun fallback legacy o `meta.toolErrors`; log `phase:model` e `phase:tool` presenti.

## Limiti osservati nelle richieste non supportate

- «qual è il piano più economico?»: Qwen passa prima `supplier:""` alla ricerca; il modulo lo rifiuta prima del datasource. Il modello poi chiama `renewals_list_entities(plan)`. L'esito complessivo resta `ERROR` con `TOOL_VALIDATION_ERROR`, senza fallback legacy; la lista alfabetica non dichiara un prezzo o un piano più economico.
- «quale piano ha più risorse?»: Qwen seleziona impropriamente `renewals_list_entities(plan)`, restituendo 199 piani, senza classifica o quantità di risorse.
- «quali piani includono email?»: Qwen seleziona impropriamente `renewals_list_entities(resourceType)`, restituendo le 15 anagrafiche delle risorse, non piani filtrati.

In nessuno dei tre casi Qwen emette `CAPABILITY_NOT_MIGRATED`. Il limite è documentato senza regex, fallback aggiuntivi o modifiche al core. F4 non dichiara supportate queste richieste.

## Proposta successiva, non implementata

F5 può introdurre `renewals_get_plan` per ID stabile e dettaglio esplicito. Il chiarimento delle risorse e le capability di ranking richiedono scope separati; non sono impliciti nella ricerca piani F4.
