# Feedback della chat

Il widget consente di valutare ogni risposta con un feedback positivo oppure di
segnalare una risposta fraintesa, errata, incompleta o inaspettata.

Le segnalazioni sono salvate in formato JSON Lines nel percorso configurato da
`AI_FEEDBACK_STORAGE_PATH` (default `./data/chat-feedback.jsonl`). In EasyPanel
la directory `/app/data` deve essere collegata a un volume persistente.

Il contenuto include domanda, risposta, modulo, intento, modello, pagina ed
entità attiva. Header e credenziali non vengono acquisiti; i campi contestuali
sono in allowlist e i pattern sensibili più comuni vengono oscurati.

## Consultazione ed export

Gli endpoint richiedono la stessa sessione Facile usata dalla chat.

- `GET /api/feedback` elenca le segnalazioni aperte.
- `GET /api/feedback?status=all` include anche quelle risolte o ignorate.
- `GET /api/feedback?rating=negative&moduleId=facile.webcamgo` filtra la coda.
- `GET /api/feedback?status=all&format=jsonl` esporta il corpus completo.

## Chiusura di una segnalazione

Inviare una richiesta `PATCH /api/feedback/:id` con:

```json
{
  "status": "resolved",
  "resolutionNote": "Aggiunto il caso all'entity resolver e ai test di regressione"
}
```

Gli stati ammessi sono `open`, `resolved` e `ignored`. Gli aggiornamenti vengono
aggiunti al file senza eliminare l'evento originale, così i casi corretti
restano disponibili come dataset di regressione.
