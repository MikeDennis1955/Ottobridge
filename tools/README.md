# Hand-scripting tools

- `dd.c`: double-dummy solver. Build: `gcc -O2 -o dd dd.c`. Input on stdin: four hands (N E S W, "S.H.D.C"), then "trump leader" (trump N for no-trump), then a card sequence. Prints DD value before/after each card; `*` marks a card that changed the DD result. End the sequence with `?` to list every legal next card with its DD value.
- `runhand.py FILE.hand TRUMP`: checks a .hand script's play with the solver (run from the folder holding `dd`).
- `gen.py` / `search.py`: random East-West completions for given North-South hands, with DD results for several contracts.
- `autoplay.py` / `runap.py` / `runf.py`: auto-play a deal choosing natural cards among DD-optimal ones (`runf.py` takes a forced prefix). Output needs human review before use.
- `check_play.py`: plain follow-suit / trick-winner simulation.

## keyscan.py FILE TRUMP
Run from a folder holding the compiled `dd`. For every North/South card in a .hand script (tricks 1-11), asks the solver for all legal alternatives and prints the cards that would cost a trick. Use it to pick starred key cards and to confirm every "not X:" note.
