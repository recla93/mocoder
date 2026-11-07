# mocoder

Un tutor dentro VS Code che ti fa costruire **a mano** il progetto che hai in testa, task dopo task:
teoria, suggerimenti a scala, controlli automatici, un commit per task.

## Iniziare

1. Apri una cartella vuota e clicca l'icona **mocoder** nella barra laterale.
2. **Crea il prompt**: descrivi la tua idea; il prompt finisce negli appunti.
3. Incollalo in qualsiasi chatbot (Claude, ChatGPT, Gemini…) e salva o copia tutta la risposta.
4. **Importa la risposta**: mocoder carica task, teoria e controlli, e corregge da solo gli errori di formato tipici.
5. Per ogni task: leggi la teoria, **Prepara e apri i file**, scrivi il codice, **Verifica**.

Funziona anche senza IA e senza rete: quando un controllo fallisce, "Cosa dice l'errore" spiega
l'output di test e compilatore. Ogni task indica anche cosa cercare per approfondire.

## Con l'IA (opzionale)

Comando **mocoder: Configura l'IA**: Claude, Ollama (anche i modelli cloud gratuiti) o qualsiasi API
OpenAI-compatibile. Sblocca il Planner integrato, il tutor che risponde alle domande senza darti la
soluzione, e la review del codice a fine task e milestone.

## Sicurezza

I controlli dei task sono comandi eseguiti sul tuo computer. Prima di eseguirli mocoder te li mostra
tutti (con ⚠ su quelli insoliti) e chiede il permesso; se cambiano, lo chiede di nuovo.
