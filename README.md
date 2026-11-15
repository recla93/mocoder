# mocoder

A tutor inside VS Code that makes you build **by hand** the project you have in mind,
task after task: theory, scaled hints, automated checks, one commit per task.

> **Status: 0.2.0, pre-release.** It works end to end (tested on Windows with Java/Maven and Python/pytest
> paths), but it is not yet 1.0: version 1.0.0 is reserved for the first public release.
> What is verified and what is not: [APP_STATUS.md](APP_STATUS.md). Architecture: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

## Requirements

| What | Why |
|---|---|
| VS Code ≥ 1.95 | mocoder is a VS Code extension |
| git | one commit per completed task (if git is missing the tutor still works, without commits) |
| The tools of the project you build | the checks run them: e.g. **JDK 17+ and Maven** for Java, **Python 3.11+ and pytest** for Python |
| Node ≥ 22.18 | only to build the package from source |

Git needs a name and an email, otherwise the task commits fail (mocoder tells you):

```bash
git config --global user.name "Your Name"
```

```bash
git config --global user.email "you@example.com"
```

## Installing

There is no Marketplace listing yet: mocoder is installed from a `.vsix` package.

1. Build the package (once, or after every update of the sources):

   ```bash
   cd extension && npm install && npm run package
   ```

   It produces `extension/mocoder.vsix`.
2. Install it (`--force` also replaces an older build with the same version):

   ```bash
   code --install-extension extension/mocoder.vsix --force
   ```

   Or: VS Code → Extensions → `…` menu → *Install from VSIX…*.
3. Reload the open windows: Command Palette → **Developer: Reload Window**. Windows that were already open keep
   running the previous build until they are reloaded.

You can check which build you have: Extensions view → mocoder → version (`0.2.0`).

## Quick start

1. Open a folder (even an empty one) and click the **mocoder** icon in the activity bar.
2. The panel proposes **three roads**, from the cheapest (you choose once, you can change later):

   | Road | Account | Model | What is missing |
   |---|---|---|---|
   | **1 · Free, no account** | none | the web chatbot you already use | the in-editor tutor; path, verification, checks and "What the error says" still work |
   | **2 · Free API** | one (Gemini, AI Studio, no card) | `gemini-flash-latest` | daily quota and reduced context (15k characters) |
   | **3 · Pay-as-you-go API** | one (DeepSeek) | `deepseek-flash` | a few cents a month (~$0.3 per million input tokens) |

3. Create the path:
   - **Road 1**: *Copy the prompt* → describe idea, level and goal → paste the prompt into Claude, ChatGPT or Gemini
     on the web → copy **the whole** answer → *Import the answer*. The typical format errors of chatbots are fixed on
     their own.
   - **Roads 2–3** (or any configured AI): *Create the path with AI*. The Planner first writes a feasibility
     assessment, then the backlog and a hidden reference solution.

   Write the idea in your language and name the technology you want (e.g. *"A Java command-line app to manage the
   loans of a small library"*): the path follows both.
4. Optional but recommended: **Verify the path checks**. For every task mocoder checks, in a temporary folder, that
   the checks fail before the work and pass with the reference solution. It needs the project's tools **and
   dependencies** installed (a missing `fastapi` makes a check fail even with the solution).
5. For each task: read the theory, **Prepare and open the files**, write the code, **Verify**.
   When the checks pass, the task is committed (`feat(T01): …`) and the next one unlocks.

**Guidance level** (`mocoder.guidance`, also in the panel): `guided` (theory open, hints up to the solution),
`hints` (asks for confirmation before the hint that is the solution), `autonomous` (no hints).

## Commands

All in the Command Palette, under **mocoder:**.

| Command | What it does |
|---|---|
| Copy the prompt to create a backlog | Road 1: asks idea, level and goal and copies the Planner prompt |
| Import backlog | Imports the chatbot answer from the clipboard or from a file |
| Create a path with AI | The built-in Planner writes feasibility, backlog and solution |
| Verify the backlog (red → green) | Checks that every task's checks fail before the work and pass after |
| Verify the current task | Runs the checks of the selected task |
| Ask for a task review | Code review of the task, as in a pull request |
| Configure AI | Chooses provider, model and key |
| Add a backup API key | A second key, used only if you confirm it when the first provider is down |

## Configuring the AI

**mocoder: Configure AI** (or the *AI: …* link at the top of the panel) opens a menu:

| Choice | Address | Key |
|---|---|---|
| Gemini · free API | fixed | free from Google AI Studio |
| DeepSeek · pay as you go | fixed | from platform.deepseek.com |
| Ollama (on this PC) | `http://localhost:11434/v1` | none: local models, or Ollama's own `:cloud` models |
| Other OpenAI-compatible provider | **asked**, e.g. `https://openrouter.ai/api/v1` | the provider's key |
| Anthropic (Claude) | fixed | from console.anthropic.com, or the `ANTHROPIC_API_KEY` variable |

Keys stay in the system keychain (VS Code SecretStorage), never in the settings or in the project.
When you ask the tutor or a review, the code of the task files is sent to the configured provider.

**Example, OpenRouter:** *Other OpenAI-compatible provider* (type `openrouter` in the menu to find it) →
address `https://openrouter.ai/api/v1` → model, e.g. one ending in `:free` → your `sk-or-…` key.
Free models have a daily request cap and per-minute limits: fine for trying mocoder and for the tutor, less
reliable for the Planner. If a `:free` model answers 404, enable free-model data use in OpenRouter's privacy settings.

**Backup key:** *Add a backup API key* stores a second provider. mocoder **never switches on its own**: when the
first provider does not answer, it asks *"Switch to your backup API key?"*.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `mocoder.guidance` | `guided` | `guided`, `hints`, `autonomous` |
| `mocoder.ai.provider` / `baseUrl` / `model` | `anthropic`, empty, `claude-opus-5-5` | set by *Configure AI* |
| `mocoder.ai.mentorModel` | empty | a cheaper model for tutor questions (empty = same model) |
| `mocoder.ai.monthlyTokenBudget` | `0` | monthly token limit, 0 = no limit; usage is shown in the panel |
| `mocoder.ai.fallback.*` | empty | set by *Add a backup API key* |

**Free or local models:** context is reduced to 15k characters for free plans and local endpoints. With local
Ollama models raise the context (`OLLAMA_CONTEXT_LENGTH=32768`): the Planner prompt contains the whole schema.
**To avoid:** Groq's free plan (8k tokens per minute and 200k per day: the tutor's context exhausts it in a few questions).

## What every path guarantees

The Planner prompt requires folder structure, build files explained line by line, `.gitignore`, README,
configuration without secrets, a database with a versioned schema and parameterized queries, security and project
conventions. The certain rules are also checked at import (`.gitignore`, `README.md`, build file for the tool used,
pinned Maven plugin and dependency versions, SQL schema in a `.sql` file); the project rules (`conventions`) stay
visible in the panel and the Reviewer checks them. The first task is done by hand; its first hint tells how real teams
generate the skeleton (e.g. `mvn archetype:generate`).

**Without AI and without network** everything works except the tutor: when a check fails, the panel explains the
error by reading the test and compiler output ("What the error says").

## Security

The task checks are commands executed on your computer, and the backlog can come from a chatbot. Before the first
verification mocoder shows all the commands (⚠ on the unusual ones) and asks you to allow them; the approval holds for
that folder and is asked again if the commands change, even when the Planner rewrites them. The reference solution
(`.mocoder/solution.yaml`) and its backups are kept out of git.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The panel looks old, or *Configure AI* asks only for the model | an older build is running: reinstall with `--force`, then **Developer: Reload Window** |
| *"Task done, but git could not commit"* | git has no name/email: see [Requirements](#requirements) |
| *"Too many requests…"* | provider quota; the message quotes the provider's reason (per-minute limit or daily cap). Your question goes back into the box: send it again later |
| *"Model or endpoint not found"* | wrong model name or address; on OpenRouter `:free` models also the privacy setting above |
| *"The provider stopped answering"* | no data for 120 s: try again or switch provider |
| A check fails *"even with the reference solution"* | the project's tools or dependencies are missing, or the check is wrong: *Copy the request for an external LLM* or *Have the Planner fix it* |
| Details of any failure | Output panel → channel **mocoder** |

## Repository

| Folder | Content |
|---|---|
| `schema/` | Backlog and solution format (JSON Schema): the contract with any LLM |
| `prompts/` | Planner, Mentor and Reviewer prompts |
| `examples/` | Complete and verified paths: Java (`registro-presenze`), Python (`analisi-spese`). Plus `broken`: a path that fails on purpose, to exercise verification, diagnostics and fixing |
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

Trying the extension: open `extension/` in VS Code and press F5 (it builds first), then open a folder with a copy of
`examples/<name>/.mocoder/`. Use copies outside this repository: completing a task runs `git init` and commits.
