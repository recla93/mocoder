# mocoder — status and handoff

Read this first if you are an LLM/agent picking up this repository.
It describes the **current state of the working tree**, what changed and why, what is
verified, what is not, and the decisions you must not undo.
Everything here is about the code; the product itself is documented in
[README.md](README.md) and [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

Snapshot date: 2026-11-15. All work below is committed on `master` (`bb07bd8`) and pushed to `origin`.

## 1. What mocoder is

A VS Code extension that guides a person to build a project **by hand**: a YAML backlog,
red→green checks per task, one commit per task, an optional AI tutor (Planner, Mentor,
Reviewer). The core works **with no AI and no network**; the AI is optional and layered
on top through two adapters (Anthropic SDK, any OpenAI-compatible endpoint).

## 2. Working tree state

- 26 modified files + 2 untracked (`examples/broken/`, `extension/src/view.test.ts`).
- `git diff --stat`: ~+1100 / −850.
- Verification **green**:
  - `node node_modules/typescript/bin/tsc -p .` → 0 errors
  - `npm run build` (esbuild) → ok, `dist/extension.cjs` ≈ 1.8 MB
  - `node --test "src/**/*.test.ts"` → **34/34 pass**
- **Committed** on `master` and pushed. The UI proof in §7 has been run (by the assistant, see §7).
- **Version 0.2.0** (`extension/package.json`), built and installed in the user's VS Code from this
  working tree. Pre-release numbering: **1.0.0 is reserved for the first public release.**
  After code changes, the installed build is stale until `npm run package` and
  `code --install-extension mocoder.vsix --force` are run again (F5 always runs the working tree).

## 3. What this work batch adds

### 3.1 Three-mode AI setup (one-time choice, no per-role slots)

The panel proposes three roads, cheapest first (implemented in `view.ts` `welcome()` and
`extension.ts` `CHOICES` / `configureAI()`):

1. **Free, no account** — copy the Planner prompt into a web chatbot, import the answer
   (`mocoder.copyPlannerPrompt` + `mocoder.import`). No key, no cost.
2. **Free API, one account** — Gemini (`gemini-flash-latest`), free key from AI Studio, no card.
3. **Paid API, one account** — DeepSeek (`deepseek-flash`), a few cents/month.

Plus Claude (Anthropic), local Ollama or any OpenAI-compatible API.

### 3.2 User-controlled backup API key (no automatic fallback)

Design: **mocoder never switches provider on its own.** The user owns the keys.

- Settings: `mocoder.ai.fallback.{provider,baseUrl,model}` (see `package.json`).
- Secret: `mocoder.apiKey.fallback.<provider>` — a **separate** secret from the primary
  `mocoder.apiKey.<provider>` (`secretKey(provider, slot)` in `extension.ts`).
- Command `mocoder.addFallbackKey` ("Add a backup API key") in the palette, plus an
  "add a backup key" link in the panel (`data-type="fallback"`).
- On a **retryable** failure with a backup configured, mocoder asks for permission:
  *"Your primary provider isn't responding. Switch to your backup API key?"*.
  With no backup it shows a notification with an "Add backup key" button.
- `AiError` now carries `unavailable: boolean` (`providers.ts`): `true` for connection
  errors, 401/403, 402, 404, 429, 5xx, provider stream errors and an empty non-streaming
  response; `false` for truncation, model refusal, 400 and the monthly-budget error.
  Only `unavailable` failures trigger the backup prompt.

### 3.3 Full English translation (product UI/messages/docs/prompts)

Everything user-facing is now English: panel, commands, notifications, error messages,
prompts, `package.json`, README, docs, JSON schema. Technical enum values were renamed too:

- Guidance: `guidato|suggerimenti|autonomo` → **`guided|hints|autonomous`**
  (`Guidance` type, `mocoder.guidance` setting, panel dropdown).
- Backlog level: `principiante|intermedio|avanzato` → **`beginner|intermediate|advanced`**
  (schema enum, `Backlog.level` type, the three example backlogs).

The AI is instructed to write **user-facing content** (titles, theory, hints, review
criteria, conventions) in **the language of the user's idea**, while identifiers, file
paths, commands and code stay English. The Italian example projects keep their Italian
content on purpose: they are *generated content*, like the Planner will produce.

## 4. Fixes applied in this batch

Earlier fixes:

1. `capFiles` context cap (60k chars) for the tutor.
2. Dated backups (`*.bak`) written before `verifyBacklog` overwrites backlog/solution.
3. `out.show(true)` when asking to approve commands (the dialog truncates the list).
4. Silent `verify()` / `review()` when nothing can run (no spurious popups).
5. Per-call AI token logging in the Output channel.
6. `diagnose-missed.jsonl` collector for failures with no offline tip + `examples/broken/`
   fixture to exercise it.

Robustness pass:

7. `AiError` messages explain the fix for 401/403/402/404/429.
8. Guard for empty non-streaming responses ("The provider replied without text").
9. `planWithAI` catch offers *"Copy the prompt for an external LLM"* so a failed Planner
   never loses the user's idea.
10. `mentorModel` is cleared when provider/baseUrl change (a model from another provider
    does not exist here).
11. Tutor history capped at `MAX_HISTORY = 8` exchanges (was unbounded → quadratic cost).
12. "change AI" link in the welcome and `AI: <model>` link in the header.

Polish pass (2026-11-14, second session):

13. `.mocoder/.gitignore` now also ignores `*.bak`: the dated `solution.yaml.*.bak` backups were
    being committed into the student's repo. Missing lines are added to existing ignore files.
14. `commit()` returns whether it succeeded; the panel no longer says "saved to git" when the
    commit failed, and a missing git identity gets a warning with the `git config` commands.
15. `openaiCompatible` aborts after 120 s with no data (`IDLE_MS`, idle, not total): a stuck
    provider no longer freezes the panel on "thinking". Anthropic still relies on the SDK timeout.
16. A tutor question whose call failed is removed from the history and put back in the box.
17. Ctrl+Enter is ignored while the tutor is thinking (it used to clear the draft and drop it).
18. The panel scrolls to a new chat message instead of leaving it below the fold.
19. `withBackup()` / `errorText()` replace the two copies of the backup-key prompt.
20. `configureAI` with no preset skipped the provider menu and silently picked **Ollama**
    (`CHOICES.find(c => c.preset === undefined)` matched the first entry without a preset).
    Every "Configure AI" from the palette, the header link and "Add a backup API key" was affected.
    Also: the menu matches on detail (typing "openrouter" works), clearer Ollama label, and the
    API address box shows the OpenRouter URL as an example. Seen working in the UI.
21. Planner prompt: a free OpenRouter model (`baidu/ernie-5.5-flash-preview:free`) turned a Java
    idea into a Spanish FastAPI path. Causes: `stack` was always "your choice", and the idea only
    appeared before ~30k chars of schema. Now `stack` defers to the idea and `planner.md` ends with
    a "Before you answer" block repeating idea, technologies and language. **Re-run live
    (2026-11-15, same free model): Italian text, Java 17 + Maven + JUnit 5, 12 tasks.**
22. Autofix: `mvn ... exec:java` without a compile phase becomes `mvn ... compile exec:java`
    (the generated T12 failed with `ClassNotFoundException`: `exec:java` does not compile).
    Rule also added to `planner.md` and `fixRequest`. Reapplied on every read, so existing
    backlogs are fixed too.
23. `plan()` keeps the Feasibility section of the first answer when a repair answer is YAML only
    (before, the whole YAML opened in place of the feasibility assessment).
24. 429/404 errors from OpenAI-compatible providers append the provider's own `error.message`
    (OpenRouter tells per-minute limit, daily cap `free-models-per-day`, upstream rate limit or
    data-policy 404 apart). Seen live: a first tutor question got 429 on the free model right after
    the Planner fix calls; the question went back to the box and the retry worked, as designed.
25. `planner.md` rule 2: the first task is done by hand; its **first hint** (never the last, which is
    the solution) says real teams generate the skeleton, with the stack's generator (Maven archetype
    quickstart / VS Code "Create Java Project", `gradle init`, `npm init`, `dotnet new`, `cargo new`)
    and what to align afterwards; files and checks never depend on generator output. Decision: mocoder does **not** run generators itself (needs the tool
    and network, clashes with given files, removes the "build by hand" point).
26. Backlog verification with missing dependencies: `VerifyFailure.kind` gains `'missing'`
    (`missingOnThisComputer` in `core/verify.ts`). A green failure caused by a missing program, a
    Maven download failure, a Python module absent from the project but declared in
    `requirements.txt`/`pyproject.toml`, or a declared npm package stops the verification with what
    to install (the pip command lists the solution's requirements, since the student's project may not
    have the file yet). The Planner fix loop stops on it and the panel offers *Verify again*, never an AI
    fix. Seen on the FastAPI backlog: T1–T2 green, T3 `STOP … fastapi is not installed`.
    shortcut: an import name different from its package name (`yaml`/`PyYAML`) stays a `green` failure;
    npm packages can never be verified in advance (npm installs into the project, not the temp folder).

Full path run (2026-11-15, installed build, real VS Code window, free OpenRouter model): the generated
Java library path (`Desktop\mocoder-prove\nuovo-progetto`, 12 tasks, 7 milestones) was completed end to end
from the panel: skeleton failing first, hints, offline tips, "Explain the error", a deliberate off-by-one in T4
caught and fixed, milestone review, 12 `feat(Tn)` commits with no solution/backup/`target/` tracked, "Path
finished". Fixes from that run:

27. Offline tip for `assertTrue`/`assertFalse` without a message: names the failing tests and lines from
    Surefire's summary instead of "expected `true` but the code produced `false`".
28. `planner.md`: every assertion in the provided tests has a message in the idea's language.
29. Mentor and Reviewer answer in the language of the task, not of the English button requests (the tutor
    answered "Explain the error" in English on an Italian path; reviews would always have been English).
    The Mentor's `guided` snippet may not be the corrected version of the student's own line (it was).
    Not re-run live after the change.
30. Milestone review button in the panel when the selected task's milestone is complete: before, the only
    entry point was a toast that disappears in seconds.
31. Panel polish: long file paths wrap; the "Path" list keeps its open/closed state across updates.

Known, not fixed: the review's "Outcome:" label stays English; generated content quality (the project README
says `mvn exec:java` without `compile`, flattened indentation in the solution's Java) is the model's.

This batch also translated all tests and fixed three test names that a first pass missed
(`extension/src/core/trust.test.ts`).

## 5. Decisions and constraints — do NOT undo

- **No automatic provider fallback.** Switching happens only after the user confirms.
  Do not add a retry-on-429/5xx chain: free-tier windows are per-minute and a test asserts
  the 429 message.
- **Free/local/Gemini endpoints use a 15k-char context cap** (`FREE_CONTEXT_CHARS`), not 60k.
  Groq free (8k TPM / 200k TPD) cannot hold mocoder's context; a full context dies in ~13
  questions.
- **Do not lower the tutor `maxTokens` (16000) to save money.** DeepSeek defaults to
  *thinking mode* and reasoning tokens count as output → truncation for zero savings.
- **Gemini and DeepSeek share the `openai` slot**, so configuring one overwrites the other's
  primary key. Accepted and documented (clear 401 message).
- **"Avoid" list stays:** Groq free tier, OpenRouter `:free` models.
- **Do not translate** the Italian example projects' content, the regexes in `diagnose.ts`
  / `checks.ts` (they match real Italian *and* English tool output), or `examples/*` test data.
- Repo docs are English; **commits are Italian** (`mocoder: <descrizione>`). Claude is credited with the plain
  last line `Co-authored with Claude Opus 5.5 (Anthropic)`, **not** a `Co-Authored-By:` trailer (the owner wants
  the credit as text, without the GitHub co-author avatar).
- Shortcuts are marked in code as `shortcut: <limit>, <when to upgrade>`; keep that form.
- **License: MIT** (chosen 2026-11-15), copyright `recla93`. `LICENSE` lives at the root and is copied into
  `extension/` so it ships in the `.vsix` (keep the two identical).
- **Marketplace publisher: `Peengu`** (created 2026-11-15, no verified domain). The extension ID is
  therefore `Peengu.mocoder`, no longer `mocoder.mocoder`: API keys (SecretStorage), command approvals
  (workspaceState) and the token counter (globalState) belong to the old ID and are not carried over.
- **Release prep (2026-11-15):** Marketplace icon `extension/media/icon.png` (128 px, rendered from
  `media/logo.svg` with headless Edge: re-render it if the logo changes); `package.json` has repository, bugs,
  homepage, keywords; `extension/CHANGELOG.md` ships in the `.vsix`. Not yet published anywhere: the first
  Marketplace upload is manual (pre-release); Open VSX needs its own account; README screenshots are missing.
- **CI** (`.github/workflows/ci.yml`): typecheck + tests + Python example red/green on Windows, Ubuntu and
  macOS; Java example red/green on Ubuntu with JDK 21; `.vsix` as a build artifact. This is the only macOS/Linux
  coverage. Its first runs found a JDK 17 vs `release 21` mismatch: mocoder now has an offline tip and a
  `missing` verification result for a JDK older than the project needs.
- **Languages:** the core runs any check command, but offline tips, test counts, command autofixes, build-file
  checks and missing-dependency detection exist only for Python/pytest and Java/Maven (+ npm partly). Plan:
  JavaScript/TypeScript next, then C#, Go, Rust; C/C++ last. The second full path should be JS/TS.

## 6. Key constants

| Constant | Value | Where |
|---|---|---|
| `MAX_CONTEXT_CHARS` | 60 000 | `ai/roles.ts` |
| `FREE_CONTEXT_CHARS` | 15 000 | `extension.ts` |
| `MAX_FILE` | 200 000 bytes | `extension.ts` |
| `MAX_HISTORY` | 8 exchanges | `extension.ts` |
| `MAX_REPAIRS` | 2 | `ai/roles.ts` |
| `MAX_FIX_ROUNDS` / `MAX_TOTAL_FIXES` | 2 / 10 | `ai/roles.ts` |
| `MAX_OUTPUT` | 20 000 chars | `core/checks.ts` |
| `MAX_SHOWN` (command dialog) | 30 | `extension.ts` |

## 7. Pending — blocked on the user

- **UI proof done by the assistant on 2026-11-14** (isolated VS Code profile,
  `--extensionDevelopmentPath`, scratch copies of the examples). Seen working: command approval
  dialog, failing check with offline tip (`broken`), T01 green on `analisi-spese` with commit
  failing for missing identity (panel + warning) and then succeeding, `.bak` and `solution.yaml`
  ignored by git, tutor against a fake local provider: 503 → question back in the box +
  "Add backup key"; answer → panel scrolls to it; token line in Output.
  **Not seen:** the three welcome cards with no AI, Ctrl+Enter (keyboard input not available to
  the assistant), the real backup-key switch, Gemini/DeepSeek with real keys.
- **Live API validation not done.** `gemini-flash-latest` and
  `https://api.deepseek.com/chat/completions` need real keys the assistant does not have.
- **Web search is broken (HTTP 402):** the OpenCode hosted Web Search balance is empty.
  Free workaround used instead: `webfetch` on
  `https://duckduckgo.com/html/?q=...`.

## 8. How to verify / run

```bash
cd extension
node node_modules/typescript/bin/tsc -p .      # typecheck
npm run build                                  # bundle (what F5 runs)
node --test "src/**/*.test.ts"                 # 33 tests
npm run verify -- ../examples/analisi-spese/.mocoder/backlog.yaml ../examples/analisi-spese/.mocoder/solution.yaml
```

## 9. File map (where things live)

| Path | Role |
|---|---|
| `extension/src/extension.ts` | Commands, panel provider, AI config + backup, git commit, trust approval |
| `extension/src/view.ts` | Webview HTML (welcome/three modes, task list, results, tutor) |
| `extension/src/ai/providers.ts` | `anthropic`, `openaiCompatible`, `withBudget`, `isFreeModel`, `AiError` |
| `extension/src/ai/roles.ts` | Planner/Mentor/Reviewer prompts and messages, `capFiles`, fix loop |
| `extension/src/core/` | Pure tested logic: `backlog`, `workspace`, `checks`, `progress`, `verify`, `trust`, `diagnose` |
| `extension/src/cli/verify.ts` | CLI: schema + red/green check of a backlog |
| `schema/backlog.schema.json` | The contract with any LLM (backlog + solution) |
| `prompts/*.md` | Planner, Mentor, Reviewer prompts (English, language rule included) |
| `examples/` | `registro-presenze` (Java), `analisi-spese` (Python), `broken` (fails on purpose) |
| `extension/package.json` | Commands, settings (incl. `mocoder.ai.fallback.*`) |
