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
- job una tantum `ollama pull qwen3:8b` dopo l'avvio o dopo il cambio modello;
- servizio applicativo costruito dal `Dockerfile` del repository.

Il volume `/root/.ollama` deve essere persistente. La porta `11434` deve restare
interna alla rete EasyPanel. Solo la porta HTTPS dell'AI API va pubblicata.

## Modello della prima release

Il modello predefinito è `qwen3:8b` Q4_K_M, distribuito con licenza Apache 2.0.
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
- https://ollama.com/library/qwen3:8b

## Variabili richieste

```dotenv
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://facile.webcloud.it

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_CHAT_MODEL=qwen3:8b
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
2. eseguire `ollama pull qwen3:8b`;
3. pubblicare l'AI API con `OLLAMA_REQUIRED=true`;
4. verificare `/health` e `/ready`;
5. pubblicare widget e integrazione Facile;
6. eseguire smoke test su letture, disambiguazione e una proposta con conferma,
   senza confermare operazioni reali durante il collaudo.
