# Benchmark locale Qwen 3.5 4B / 9B — evidenze prima di F6

Verifiche del 6 ottobre 2026, tramite POST reale `/api/chat` e Ollama locale. Stesso working tree, tool, template di sistema, contratti e dati CRM congelati tra i modelli; temperatura 0, thinking false, contesto 4096. Modelli già disponibili, nessun download. Timeout chat temporaneo comune 300 s, contro i 120 s della configurazione permanente; router invariato. Nessuna configurazione permanente modificata.

La suite originaria comprende 40 richieste, più due replay della negazione con snapshot identico dei 27 servizi. Singleton e cinque richieste non supportate hanno due prove per modello; gli altri casi una sequenza primaria. Il supplemento WebcamGo comprende soltanto due POST ulteriori con credenziale reale runtime. Nessun token, header di autenticazione o credenziale è incluso in questo documento.

| Caso | 4B | 9B |
|---|---|---|
| Singleton Logicom → quanto costa? | Usa AnyDeskStd1y, ambiguo fra due piani | Usa ID verificato, dettaglio Logicom corretto, prezzo catalogo 344,64 |
| Aruba → dettaglio Aruba-pecprem | search_plans → get_plan, corretto | Stessi tool, corretto |
| Piano più economico | Fornitore vuoto, TOOL_VALIDATION_ERROR; poi lista 199; ERROR | Lista 199, HANDLED errato |
| Piano con più risorse | Lista 199, HANDLED errato | Identico |
| Confronto DomAssLicBase / Aruba-pecprem | Due get_plan emessi, soltanto il primo eseguito, HANDLED errato | Identico |
| Addon disponibili | CAPABILITY_NOT_MIGRATED → legacy, 38 addon | Identico |
| Gruppi clienti nel catalogo | Lista di 18 fornitori al posto dei gruppi | Identico |
| WebcamGo senza credenziale specifica | Capability Webcloud generica, non valutabile come fallback WebcamGo | Identico |
| Servizi Zilio → 2026 → esclusione | 83 → 27 → 24 | 83 → 27 → 0: aggiunge flags:[to-renew] |
| Ultima comunicazione | search_communications con latest:true, corretto | Identico |

Il singleton è verificato con payload identico salvo modello: l'ID è presente sia nella fase state sia nella principale. Il replay della negazione usa lo stesso snapshot e lo stesso payload principale: 4B restituisce ancora 24, 9B 0, aggiungendo il flag errato anche insieme a dontRenewMode:exclude. Il primo errore è principalmente model-related; il secondo è argument-selection senza perdita del cliente/anno.

CAPABILITY_NOT_MIGRATED è corretto soltanto per addon: 2/10 prove delle cinque richieste non supportate, per entrambi. I due modelli condividono una famiglia: errori comuni non dimostrano automaticamente una causa architetturale. È invece provato il ritorno prematuro del primo tool terminale, che ignora il resto del batch e motiva F6.

Media totale della suite di 20 richieste per modello: 4B 65,970 s, 9B 97,466 s (+47,7%); mediane 53,678 / 75,903 s. Il replay della negazione è escluso dalle medie. Sei chiamate native del 9B superano singolarmente i 120 s correnti, più una nel replay: il benchmark non prova la compatibilità operativa del 9B con quel timeout. Latenze locali descrittive su GTX 950M, influenzate da contesto/cache.

## Supplemento WebcamGo con credenziale reale

Stesso prompt: «Quante webcam sono offline?». Stessi codice, prompt e configurazione del benchmark; la credenziale aggiuntiva è usata soltanto in memoria dal processo temporaneo, poi chiuso.

| Campo | qwen3.5:4b | qwen3.5:9b |
|---|---|---|
| Selezione | Interpreta erroneamente facile.webcamgo.read come tool callable; poi tenta agent_report_outcome | agent_report_outcome, capability facile.webcamgo.read |
| Outcome | ERROR | CAPABILITY_NOT_MIGRATED |
| Legacy fallback | No | Sì, raggiunge realmente facile.webcamgo |
| fallbackReason | null | capability-not-migrated |
| Risultato | Numero massimo di passaggi raggiunto, nessun risultato verificato | 30 webcam offline su 70; conteggio verificato sul backend WebcamGo |
| ToolErrors | TOOL_UNAVAILABLE ×1, successivi AGENT_MIGRATION_CONFLICT ×3 | Nessuno |
| Durata totale POST | 255,527 s | 246,046 s |
| Corretto | No | Sì |

Il 9B raggiunge il modulo e il backend WebcamGo, non la capability Webcloud generica. Il 4B non avvia alcun fallback dopo l'errore iniziale: la protezione resta valida. I tempi del supplemento non sono inclusi nelle medie della suite originaria.

## Debito tecnico separato, dopo F6

**Distinzione model-facing fra tool callable e capability non migrata.** Analizzare perché il 4B usa un ID del catalogo capability come nome di funzione, mentre il 9B usa correttamente il control tool. Nessuna correzione di prompt, tool description, schema, routing o core per questo caso durante F6. Non interpretare TOOL_UNAVAILABLE come un'autorizzazione al fallback; non aggiungere regex o conversioni automatiche capability → tool.
