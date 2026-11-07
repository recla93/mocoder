# mocoder

Un tutor dentro VS Code che ti fa costruire **a mano** il progetto che hai in testa,
task dopo task: teoria, suggerimenti a scala, controlli automatici, un commit per task.

Architettura e roadmap: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Come funziona

1. Apri una cartella vuota → pannello **mocoder** → *Crea il prompt*: descrivi l'idea.
2. Incolla il prompt nel tuo LLM (Claude, ChatGPT, locale…) e copia tutta la risposta.
3. *Importa la risposta*: mocoder valida backlog e soluzione e, se vuoi, verifica che ogni
   controllo fallisca prima del lavoro e passi dopo.
4. Per ogni task: leggi la teoria, *Prepara e apri i file*, scrivi il codice, *Verifica*.

Livello di guida (`mocoder.guidance`): `guidato`, `suggerimenti`, `autonomo`.

### Con l'IA (opzionale)

Comando **mocoder: Configura l'IA**: Claude (Anthropic), Ollama in locale o qualsiasi API OpenAI-compatibile.
Le chiavi restano nel portachiavi del sistema. Poi:

- **Crea il percorso con l'IA**: il Planner valuta la fattibilità, scrive backlog e soluzione e si corregge da solo se lo schema non torna.
- **Tutor IA** nel pannello: domande sul task e "Spiegami l'errore". Risponde con domande e concetti, non con la soluzione.
- **Review** a fine task e a fine milestone, come in una pull request.

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

Verifica di un backlog (schema + rosso/verde su ogni task; servono gli strumenti del progetto, es. Maven o pytest):

```bash
npm run verify -- ../examples/analisi-spese/.mocoder/backlog.yaml ../examples/analisi-spese/.mocoder/solution.yaml
```

Provare l'estensione: apri `extension/` in VS Code e premi F5, poi apri una cartella con dentro
una copia di `examples/<nome>/.mocoder/`.
