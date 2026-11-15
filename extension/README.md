# mocoder

A tutor inside VS Code that makes you build **by hand** the project you have in mind, task after task:
theory, scaled hints, automated checks, one commit per task.

## Getting started

1. Open an empty folder and click the **mocoder** icon in the side bar.
2. **Create the prompt**: describe your idea; the prompt ends up in the clipboard.
3. Paste it into any chatbot (Claude, ChatGPT, Gemini…) and save or copy the whole answer.
4. **Import the answer**: mocoder loads tasks, theory and checks, and fixes the typical format errors on its own.
5. For each task: read the theory, **Prepare and open the files**, write the code, **Verify**.

It also works without AI and without network: when a check fails, "What the error says" explains
the test and compiler output. Every task also indicates what to search for to go deeper.

## With AI (optional)

Command **mocoder: Configure the AI**: Claude, Ollama (including the free cloud models) or any
OpenAI-compatible API. It unlocks the built-in Planner, the tutor that answers questions without giving you the
solution, and the code review at the end of a task and a milestone.

## Security

The task checks are commands executed on your computer. Before running them mocoder shows you
all of them (with ⚠ on the unusual ones) and asks permission; if they change, it asks again.
