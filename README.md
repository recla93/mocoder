# mocoder

Un tutor dentro VS Code che ti fa costruire **a mano** il progetto che hai in testa,
task dopo task: teoria, suggerimenti a scala, controlli automatici, un commit per task.

Architettura e roadmap: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Installare

Il pacchetto si crea con `npm run package` nella cartella `extension/` (produce `extension/mocoder.vsix`), poi:

```bash
code --install-extension extension/mocoder.vsix
```

In alternativa: VS Code → Estensioni → menu `…` → *Installa da VSIX…*. mocoder funziona solo nelle cartelle
attendibili, perché esegue i comandi dei controlli.

## Come funziona

1. Apri una cartella vuota → pannello **mocoder** → *Crea il prompt*: descrivi l'idea.
2. Incolla il prompt nel tuo LLM (Claude, ChatGPT, locale…) e copia tutta la risposta.
3. *Importa la risposta*: mocoder valida backlog e soluzione e, se vuoi, verifica che ogni
   controllo fallisca prima del lavoro e passi dopo.
4. Per ogni task: leggi la teoria, *Prepara e apri i file*, scrivi il codice, *Verifica*.

Livello di guida (`mocoder.guidance`): `guidato`, `suggerimenti`, `autonomo`.

**Fondamenta garantite:** il prompt chiede struttura delle cartelle, file di build spiegati, `.gitignore`, README,
configurazione senza segreti, database con schema versionato e query parametrizzate, sicurezza e convenzioni.
Le regole certe sono anche controllate all'import (`.gitignore`, `README.md`, file di build per lo strumento usato,
plugin e dipendenze Maven con versione fissata, schema SQL in un file `.sql`); le regole del progetto (`conventions`)
restano visibili nel pannello e il Reviewer le verifica.

**Sicurezza:** i controlli dei task sono comandi eseguiti sul tuo computer e il backlog può arrivare da un chatbot.
Prima della prima verifica mocoder mostra tutti i comandi (⚠ su quelli insoliti) e chiede di consentirli; l'approvazione
vale per quella cartella e decade se i comandi cambiano, anche quando li riscrive il Planner.

**Senza IA e senza rete** funziona tutto tranne il tutor: il prompt si incolla in qualsiasi chatbot, la risposta
si importa dagli appunti (gli errori di formato tipici dei chatbot vengono corretti da soli) e, quando un controllo
fallisce, il pannello spiega l'errore leggendo l'output di test e compilatore ("Cosa dice l'errore").

### Con l'IA (opzionale)

Comando **mocoder: Configura l'IA**: Claude (Anthropic), Ollama in locale o qualsiasi API OpenAI-compatibile.
Le chiavi restano nel portachiavi del sistema. Poi:

- **Crea il percorso con l'IA**: il Planner valuta la fattibilità, scrive backlog e soluzione e si corregge da solo se lo schema non torna.
- **Tutor IA** nel pannello: domande sul task e "Spiegami l'errore". Risponde con domande e concetti, non con la soluzione.
- **Review** a fine task e a fine milestone, come in una pull request.
- **Verifica del backlog**: se un controllo non funziona, *Fai correggere al Planner* (fino a 2 tentativi per task)
  oppure *Copia la richiesta per un LLM esterno* e reimporta la risposta. Correggere i test richiede un modello capace:
  i modelli gratuiti piccoli vanno bene per il tutor, meno per questo.

Impostazioni: `mocoder.ai.model` (default `claude-opus-5-5`), `mocoder.ai.mentorModel` (un modello economico o locale
per le domande), `mocoder.ai.monthlyTokenBudget` (0 = senza limite).

**Gratis senza appesantire il PC:** Ollama con un modello cloud del piano gratuito, es. `gemma4:31b-cloud`
(gira sui server di Ollama; serve aver fatto l'accesso in Ollama). Con i modelli locali alza il contesto
(`OLLAMA_CONTEXT_LENGTH=32768`): il prompt del Planner contiene lo schema intero.
I modelli gratuiti di OpenCode non si possono usare da client esterni (rispondono 403).

## Repository

| Cartella | Contenuto |
|---|---|
| `schema/` | Formato del backlog e della soluzione (JSON Schema): il contratto con qualsiasi LLM |
| `prompts/` | Prompt di Planner, Mentor e Reviewer |
| `examples/` | Percorsi completi e verificati: Java (`registro-presenze`), Python (`analisi-spese`) |
| `extension/src/core/` | Logica pura e testata: backlog, file, controlli, progressi, verifica rosso/verde |
| `extension/src/ai/` | Provider IA (Claude, OpenAI-compatibile), budget, ruoli |
| `extension/src/` | Estensione VS Code: pannello tutor e comandi |

## Sviluppo

Serve Node ≥ 22.18 (esegue TypeScript direttamente).

```bash
cd extension && npm install
```

```bash
npm test
```

```bash
npm run typecheck && npm run build
```

```bash
npm run package
```

Verifica di un backlog (schema + rosso/verde su ogni task; servono gli strumenti del progetto, es. Maven o pytest):

```bash
npm run verify -- ../examples/analisi-spese/.mocoder/backlog.yaml ../examples/analisi-spese/.mocoder/solution.yaml
```

Provare l'estensione: apri `extension/` in VS Code e premi F5, poi apri una cartella con dentro
una copia di `examples/<nome>/.mocoder/`.
