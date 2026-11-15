# mocoder

A tutor inside VS Code that makes you build **by hand** the project you have in mind,
task after task: theory, scaled hints, automated checks, one commit per task.

Architecture and roadmap: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Installing

The package is built with `npm run package` in the `extension/` folder (it produces `extension/mocoder.vsix`), then:

```bash
code --install-extension extension/mocoder.vsix
```

Alternatively: VS Code → Extensions → `…` menu → *Install from VSIX…*. mocoder only works in
trusted folders, because it runs the check commands.

## How it works

1. Open an empty folder → **mocoder** panel → *Create the prompt*: describe your idea.
2. Paste the prompt into your LLM (Claude, ChatGPT, local…) and copy the whole answer.
3. *Import the answer*: mocoder validates backlog and solution and, if you want, verifies that every
   check fails before the work and passes after.
4. For each task: read the theory, *Prepare and open the files*, write the code, *Verify*.

Guidance level (`mocoder.guidance`): `guided`, `hints`, `autonomous`.

**Guaranteed foundations:** the prompt asks for folder structure, explained build files, `.gitignore`, README,
configuration without secrets, a database with a versioned schema and parameterized queries, security and conventions.
The certain rules are also checked at import (`.gitignore`, `README.md`, build file for the tool used,
Maven plugins and dependencies with a pinned version, SQL schema in a `.sql` file); the project rules (`conventions`)
stay visible in the panel and the Reviewer checks them.

**Security:** the task checks are commands executed on your computer and the backlog can come from a chatbot.
Before the first verification mocoder shows you all the commands (⚠ on the unusual ones) and asks you to allow them;
the approval holds for that folder and expires if the commands change, even when the Planner rewrites them.

### Three roads, from the cheapest

| Road | Account | Model | What is missing |
|---|---|---|---|
| **Free, no account** | none | the web chatbot you already use | the in-editor tutor; verification, checks and "What the error says" still work |
| **Free API** | one (Gemini, AI Studio, no card) | `gemini-flash-latest` | daily quota and reduced context (15k characters): the free plan cannot hold a full context |
| **Pay-as-you-go API** | one (DeepSeek) | `deepseek-flash` | a few cents a month (~$0.3 per million input tokens) |

The panel proposes the three roads when the AI is not configured yet, and you choose once. The keys stay in the
system keychain: mocoder does not resell tokens and does not act as an intermediary.

**Without AI and without network** everything works except the tutor: the prompt is pasted into any chatbot, the
answer is imported from the clipboard (the typical format errors of chatbots are fixed on their own) and, when a check
fails, the panel explains the error by reading the test and compiler output ("What the error says").

### With AI (optional)

Command **mocoder: Configure the AI**: the two API roads above, plus Claude (Anthropic), local Ollama or any
OpenAI-compatible API. The keys stay in the system keychain. Then:

- **Create the path with AI**: the Planner assesses feasibility, writes backlog and solution and corrects itself if the schema does not fit.
- **AI Tutor** in the panel: questions about the task and "Explain the error". It answers with questions and concepts, not with the solution.
- **Review** at the end of a task and of a milestone, as in a pull request.
- **Backlog verification**: if a check does not work, *Have the Planner fix it* (up to 2 attempts per task)
  or *Copy the request for an external LLM* and re-import the answer. Fixing the tests requires a capable model:
  small free models are fine for the tutor, less so for this.

Settings: `mocoder.ai.model` (default `claude-opus-5-5`), `mocoder.ai.mentorModel` (a cheap or local model
for questions), `mocoder.ai.monthlyTokenBudget` (0 = no limit).

**Free without weighing down the PC:** Ollama with a cloud model from the free plan, e.g. `gemma4:31b-cloud`
(it runs on Ollama's servers; you need to have signed in to Ollama). With local models raise the context
(`OLLAMA_CONTEXT_LENGTH=32768`): the Planner prompt contains the whole schema.
The free models of OpenCode cannot be used from external clients (they answer 403).

**To avoid:** the free plan of Groq (8k tokens per minute and 200k per day: the tutor's context exhausts it in
a few questions) and the `:free` models of OpenRouter (unstable endpoints, sometimes without tool support).

## Repository

| Folder | Content |
|---|---|
| `schema/` | Backlog and solution format (JSON Schema): the contract with any LLM |
| `prompts/` | Planner, Mentor and Reviewer prompts |
| `examples/` | Complete and verified paths: Java (`registro-presenze`), Python (`analisi-spese`). Plus `broken`: a test path that fails on purpose, to exercise verification, diagnostics and fixing |
| `extension/src/core/` | Pure, tested logic: backlog, files, checks, progress, red/green verification |
| `extension/src/ai/` | AI providers (Claude, OpenAI-compatible), budget, roles |
| `extension/src/` | VS Code extension: tutor panel and commands |

## Development

Requires Node ≥ 22.18 (it runs TypeScript directly).

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

Verify a backlog (schema + red/green on every task; the project's tools are needed, e.g. Maven or pytest):

```bash
npm run verify -- ../examples/analisi-spese/.mocoder/backlog.yaml ../examples/analisi-spese/.mocoder/solution.yaml
```

Trying the extension: open `extension/` in VS Code and press F5, then open a folder with a copy of `examples/<name>/.mocoder/`.
