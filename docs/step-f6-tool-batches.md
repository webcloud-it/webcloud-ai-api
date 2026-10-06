# Step F6 — integrità dei batch con multiple tool_calls

## Problema verificato

Nel [benchmark 4B/9B](model-benchmark-4b-9b.md), entrambi emettono due get_plan per il confronto, ma il primo tool terminale chiude la conversazione. La seconda chiamata non viene validata né eseguita e la risposta parziale è dichiarata HANDLED.

F6 interviene sul contratto di esecuzione, senza implementare comparison, ranking o aggregazioni e senza modificare prompt, definizioni dei tool, schema, router o configurazione. La distinzione callable/capability osservata nel supplemento WebcamGo resta debito separato da analizzare dopo F6.

## Contratto

- Singola tool call: percorso, validazione, policy, stato e risultato terminale invariati.
- Batch di più tool applicativi: preflight dell'intero batch prima della prima esecuzione. Ogni chiamata deve risolvere un tool registrato, superare read/low, credenziale/principal/capability, parsing JSON, merge dello stato e schema. Gli errori riportano l'indice della chiamata; se uno fallisce, nessun tool del batch viene eseguito.
- Un control tool deve essere l'unica chiamata del passaggio. Decisioni miste o più control call producono AGENT_MIGRATION_CONFLICT prima dell'esecuzione.
- Qualunque batch con un tool terminale è rifiutato con AGENT_TERMINAL_BATCH_UNSUPPORTED. Non esiste un contratto di composizione delle risposte terminali: non eseguire soltanto un prefisso, non convertire il rifiuto in CAPABILITY_NOT_MIGRATED e non avviare legacy.
- I batch validi di soli read non terminali vengono eseguiti in ordine e tutte le risposte vengono restituite al modello. Ogni sibling usa lo stesso stato disponibile all'inizio del batch; non eredita implicitamente nuovi filtri prodotti da un'altra chiamata del medesimo batch. Policy e schema sono verificati anche immediatamente prima dell'esecuzione.
- Un errore durante l'esecuzione interrompe il resto del batch e produce ERROR. Eventuali read già riusciti restano registrati, ma non sono presentati come risultato completo e non producono un nuovo agentState utilizzabile. Non c'è rollback dei read e non sono ammesse write automatiche.

## Esito osservabile

Un batch rifiutato o fallito restituisce data.type=tool-error, il codice della causa e meta.toolBatch con iteration, status (rejected/failed), requested, attempted, completed e nomi delle chiamate richieste. meta.toolCalls conserva le esecuzioni realmente tentate, distinguendo quelle fallite. Nessun argomento, credenziale o dettaglio privato dell'errore runtime è aggiunto ai metadata del batch.

executeAgentRequest classifica questi risultati come ERROR; HTTP 200 da solo non indica successo. Il fallback resta consentito esclusivamente dal control outcome valido CAPABILITY_NOT_MIGRATED.

Il confronto del benchmark, se il modello emette ancora due get_plan, ora termina esplicitamente ERROR con zero esecuzioni. Questo corregge il falso completamento; il riconoscimento linguistico della capability comparison non migrata resta fuori da F6.

## Verifica

La suite dedicata copre batch terminali, misti terminale/non terminale, control esclusivo, preflight con tool sconosciuti/JSON/schema/policy/auth/capability invalidi, stato dei sibling, esecuzione completa dei non terminali, errori intermedi e regressione terminale singola. La POST /api/chat è coperta con provider controllato che riproduce le tool_calls reali del benchmark, nei due ingressi globale ed esplicito.

Baseline npm test prima di F6: 811 test, 793 pass e 18 fallimenti preesistenti (16 aspettative del routing precedente, fixture keep_alive, intervallo temporale Send in Italy). Risultato finale: 841 test, 823 pass e gli stessi 18 fallimenti, confrontati per nome; nessun nuovo fallimento. I 30 test F6 passano. Suite mirata agent-batch, agent-first, agent-conversation e proposal-gate: 184/184 pass.

Tre invarianti storiche F1/F4/F5 imponevano l'immutabilità byte-per-byte di tutto globalConversation rispetto a HEAD. F6 autorizza il cambiamento dell'esecuzione: quelle verifiche continuano a proteggere tutti gli altri file e la nuova suite confronta esattamente le sezioni model-facing (tool visibility, history/state/context, prompt e opzioni di inferenza) con HEAD. Nessun test viene saltato e nessuna validazione runtime viene disabilitata.

Vera POST /api/chat, Ollama locale qwen3.5:4b, stessa configurazione temporanea del benchmark (temperatura 0, thinking false, contesto 4096, timeout chat 300 s), sole credenziali CRM:

| Richiesta | Risultato verificato | Durata totale |
|---|---|---|
| confronta DomAssLicBase e Aruba-pecprem | Il modello emette due renewals_get_plan. ERROR, AGENT_TERMINAL_BATCH_UNSUPPORTED; requested=2, attempted=0, completed=0, toolCalls=[]; nessun fallback, nessun dettaglio parziale | 96,609 s |
| dammi i dettagli di Aruba-pecprem | Una renewals_get_plan, HANDLED, piano corretto, nessun toolErrors/fallback | 36,178 s |

Il payload completo della richiesta modello del confronto è identico a quello del benchmark prima di F6: prompt, tool definitions e opzioni invariati. Cambia soltanto la gestione backend delle tool_calls ricevute.

Un primo tentativo nativo è scaduto prima di produrre tool_calls: un runner residuo del test precedente aveva impedito l'offload GPU e il modello era stato caricato interamente sulla CPU. Il tentativo è conservato separatamente nei diagnostici temporanei; non è dichiarato una verifica applicativa superata. Dopo chiusura del runner e riavvio dei soli processi temporanei, senza cambiare configurazioni, entrambi i controlli sopra passano. Gli alberi di processi temporanei sono stati chiusi al termine.

La sequenza supportata servizi 83 → 27 → 24 e communications latest, i due ingressi dell'orchestrator, auth/principal, JSON/schema, write/high e assenza di fallback dopo errori restano verificati dalle suite automatiche. Il confronto resta una capability business non migrata: F6 impedisce il falso completamento senza implementarlo o forzare il modello a dichiarare CAPABILITY_NOT_MIGRATED.
