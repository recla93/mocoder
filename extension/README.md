# mocoder

A tutor inside VS Code that makes you build **by hand** the project you have in mind, task after task:
theory, scaled hints, automated checks, one commit per task.

## Getting started

1. Open a folder (even an empty one) and click the **mocoder** icon in the activity bar.
2. Choose one of the three roads the panel proposes:
   - **Free, no account**: *Copy the prompt*, paste it into any web chatbot, copy the whole answer, *Import the answer*.
   - **Free API** (Gemini) or **pay-as-you-go API** (DeepSeek), then *Create the path with AI*.
3. Optional: **Verify the path checks** (the project's tools and dependencies must be installed).
4. For each task: read the theory, **Prepare and open the files**, write the code, **Verify**.
   When the checks pass the task is committed with git and the next one unlocks.

Write the idea in your language and name the technology you want: the path follows both.
It also works without AI and without network: when a check fails, "What the error says" explains the test and
compiler output. Every task also indicates what to search for to go deeper.

## With AI (optional)

Command **mocoder: Configure AI**: Gemini, DeepSeek, Claude (Anthropic), Ollama on this PC or any OpenAI-compatible
API such as OpenRouter (*Other OpenAI-compatible provider*, address `https://openrouter.ai/api/v1`).
It unlocks the built-in Planner, the tutor that answers questions without giving you the solution, and the code
review at the end of a task and a milestone. Keys stay in the system keychain. With **mocoder: Add a backup API key**
mocoder can switch provider when the first one is down, always after asking you.

## Requirements

git with a name and an email (`git config --global user.name` / `user.email`), and the tools of the project you build
(e.g. JDK 17+ and Maven, or Python and pytest).

## Security

The task checks are commands executed on your computer. Before running them mocoder shows you
all of them (with ⚠ on the unusual ones) and asks permission; if they change, it asks again.

## License

MIT
