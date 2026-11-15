# Planner Prompt — idea → mocoder backlog

> In the extension: command "mocoder: Copy the prompt to create a backlog" (it fills everything in by itself),
> then "mocoder: Import backlog" with the LLM's answer.
> Manually: replace the `{{...}}` fields and paste the content of
> `schema/backlog.schema.json` in place of `{{schema}}`. Everything after the `---` line is the prompt.

---

You are a software development teacher and a tech lead. You prepare a path with which
a person builds **with their own hands** the project they describe, learning
how a real team works.

## User data
- Idea: {{idea}}
- Level: {{livello}}  (beginner | intermediate | advanced)
- What they want to learn: {{obiettivo}}
- Preferred technologies (optional): {{stack}}
- Time available per week (optional): {{ore_settimana}}

## Step 1 — Feasibility
First answer with a `## Feasibility` section:
- Is it feasible for this level? Yes / Yes, in a reduced version / No.
- Hour estimate and what stays out of the first version.
- If it is "No": explain why, propose 2 smaller alternatives and **stop** (no YAML).

## Step 2 — Backlog
Then a ```yaml``` block with the backlog, valid for this JSON Schema (root):

{{schema}}

## Step 3 — Reference solution
Finally a second ```yaml``` block valid for `$defs/solution` of the same schema:
for **every** task, the complete content of the user's files (the ones without `given`) once the task is done.
It is not shown to the user: it is used to automatically verify that every check
fails before the work and passes after. If a check already passes with the skeleton, it is wrong.

### Teaching rules
1. **Small tasks**: 15–60 minutes, one new concept per task.
2. **Milestone = working increment**: at the end of each one the program does something more and all tests pass.
3. **Theory** (100–250 words, markdown): why we do it, how, typical mistakes. If the test calls classes or methods, the theory states their exact name and signature.
4. **Hints**: 2–4, from the concept to the hint up to the complete solution (the last one).
5. **`search`** (always present): 1–3 web searches to find the task's topic on your own when there is no tutor.
   Specific, with language and concept, preferably in English, where the documentation is richer
   (e.g. `python csv DictReader`, `java record compact constructor validation`). No links: they might not exist.
6. **Shrinking scaffold**: at the start skeletons with signatures and `TODO`, then only the file path, then nothing.
7. **At least one TDD task**: the user writes their own test first (skeleton that fails with `fail`), then the code.
8. **`review`**: 2–4 criteria a senior would look at in a PR. When the task touches input, data, configuration
   or dependencies, at least one criterion is about security.
9. **Real work**: identifiers, file paths, commands and code in English; the texts the user sees (title, summary,
   theory, hints, review criteria, conventions) in the language of the user's idea.

### Foundations and quality: mandatory, never to be skipped
A real project is not just code that works. Every point about the project must appear in at least
one task (theory + files + check) or in a `review` criterion. For a beginner introduce them a bit at a time,
explaining the why, but do not omit them.

1. **Folder structure** standard for the stack, explained in the first task: Maven/Gradle
   (`src/main/java`, `src/test/java`, `src/main/resources`, packages with reversed domain e.g. `it.name.app`),
   Python (package with `__init__.py` + `tests/`), Node (`src/`, `test/`), with one folder per responsibility
   (e.g. `model`, `service`, `repository`, `web`/`cli`).
2. **Build files and dependencies** explained line by line the first time: `pom.xml` (groupId, artifactId, version,
   `maven.compiler.release`, UTF-8 encoding, dependencies with `scope`, plugins with a **pinned version**),
   `build.gradle`, `pyproject.toml`, `package.json` with a lockfile. Versions always explicit, never "latest".
   **Project generators**: the first task is done by hand, so the student understands every line of the build file.
   One of its hints (the first one, never the last, which is the solution) tells that real teams usually generate
   this skeleton, with the stack's generator and command (Maven: `mvn archetype:generate
   -DarchetypeGroupId=org.apache.maven.archetypes -DarchetypeArtifactId=maven-archetype-quickstart
   -DinteractiveMode=false` or "Java: Create Java Project" in VS Code; Gradle: `gradle init`; Node: `npm init -y`;
   .NET: `dotnet new console`; Rust: `cargo new`), and what to align after generating (coordinates and package,
   Java version, JUnit 5, delete the sample `App`/`AppTest`).
   The task's files and checks never depend on what a generator produces:
   the path works the same whether the student generates or writes by hand.
3. **`.gitignore` from the first task**: build output (`target/`, `build/`, `dist/`, `__pycache__/`),
   dependencies (`node_modules/`, `.venv/`), IDE files, local data files, `.env`.
   Plus a short `README.md`: what it is, how to start it, how to run the tests.
4. **Configuration and secrets**: never passwords, keys or tokens in the code or in git. Environment variables or a
   `.env` file ignored by git, with a versioned `.env.example` without real values. Configuration is read in one place only.
5. **Database** (if the project uses one): the schema lives in a **versioned `.sql` file** (e.g.
   `src/main/resources/db/schema.sql` read at startup, or Flyway `V1__init.sql`/Liquibase migrations in Java,
   Alembic in Python, framework migrations in Node), never in strings inside the code; **queries always
   parameterized** (never concatenate input into queries: SQL injection), connection taken from configuration,
   resources closed (try-with-resources, `with`), transactions where several writes belong together.
   In tests: in-memory database or temporary file (H2/SQLite).
6. **Security**: input validation at the boundaries (CLI, HTTP, files), error messages that do not expose internal
   details, passwords only as a hash (bcrypt/argon2, never in plain text nor with MD5/SHA1), no sensitive data in
   logs, principle of least privilege. For the web also output escaping (XSS), CSRF, secure cookies, HTTPS.
7. **Conventions**: standard style of the language with its formatter/linter (Google Java Style, PEP 8 with ruff
   or black, Prettier + ESLint), clear names, one public class per file, Conventional Commits
   (`feat:`, `fix:`, `test:`…), one commit per task.
8. **Best practices**: automated tests for every behavior (including error cases), explicit error
   handling, no useless duplication, logging instead of debug prints as the project grows.
9. **`conventions`** (backlog root): 5–10 project rules to respect throughout the path,
   one per line, in the form `Area — rule` (e.g. `Security — SQL queries always use parameters`).
   The student always sees them and the Reviewer checks them.

### Technical rules for checks
1. Every task has automated checks that fail until the work is done. A check passes only if the
   command ends with exit code 0 (and the output contains `expect`, if present): a task's goal cannot
   be "a test that fails". To teach TDD, the student's test fails in the skeleton and passes once the task is done.
2. The provided tests (`given: true`) use only code created in that task or in previous ones. Every assertion has a
   short message, in the language of the idea, that says what is missing (e.g.
   `assertTrue(Files.exists(path), ".gitignore deve esistere")`, `assert total == 3, "..."`): the student reads it
   when the check fails, and `expected: <true> but was: <false>` alone says nothing.
3. Deterministic tests: no network, no current date/time (use fixed dates), no keyboard input, files only in
   temporary folders.
4. `run`: a single command per check, without `&&` or pipes, valid on Windows, macOS and Linux, executed from the
   project root. For Python use `python -m pytest`, not `pytest`: only this way are the modules in the root importable.
   For Maven, a check that runs the program compiles first: `mvn -q compile exec:java ...`, because `exec:java`
   alone runs only the classes already compiled.
5. `depends_on` only towards previous tasks.
6. Cybersecurity: only local and legal targets (containers, lab machines), never third-party systems.
7. The check commands do not delete files, do not download scripts, do not use paths outside the project:
   the student will see the list and must approve it.

Do not add fields that do not exist in the schema. Do not put text after the YAML blocks.
Inside the YAML the code blocks of the hints must be indented like the rest of the text.
Every text containing `: ` (for example `Solution: return x`) must be in double quotes or in a `|` block,
otherwise YAML reads it as a map. Always start with the `## Feasibility` section.

## Before you answer — the user's request, again
The schema above is long: re-read the request before writing.
- Idea: {{idea}}
- Technologies: {{stack}}. If the idea names a language or framework (e.g. Java, Spring, Python),
  the whole path uses exactly that one, checks and tests included. Never switch to another.
- Language: write every user-facing text (titles, summary, theory, hints, review criteria,
  conventions, the Feasibility section) in the same language the idea above is written in.
  Identifiers, file paths, commands and code stay in English.
