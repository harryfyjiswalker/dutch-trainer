# Dagelijks Nederlands

A daily 30-minute English → Dutch sentence trainer, from A1 to B2.

**Use it:** https://harryfyjiswalker.github.io/dutch-trainer/

## How it works

1. You see an English sentence. Type it in Dutch. Guess freely: there are no grammar lessons, you pick up the patterns from the corrections.
2. Say it out loud. Tap **Say it** and the browser's Dutch speech recogniser checks how clearly each word came across.
3. Press **Check**. You get a word-by-word comparison with natural Dutch (and accepted alternatives), and you hear it read by a Dutch voice.
4. Rate yourself (**Again / Hard / Good / Easy**). The scheduler (an SM-2 variant, like Anki or Memrise) brings the sentence back just before you'd forget it. Sentences you miss come back within the same session.

A sentence counts as **known** once its review interval reaches 21 days.

## Content

About 4,300 hand-written sentences in `data/`, using roughly 4,200 different Dutch word forms:

| Level | Sentences | Covers, implicitly |
|---|---|---|
| A1 | 575 | greetings, present tense, questions, word order, basic perfect tense |
| A2 | 1,118 | past tenses, separable and reflexive verbs, comparisons, subordinate clauses, *er*, everyday vocabulary (home, kitchen, body, town, jobs, travel) |
| B1 | 1,306 | relative clauses, conditionals, passive, reported speech; vocabulary for work, admin, money, health, media, society |
| B2 | 1,279 | modal particles, nuanced argument, formal register; vocabulary for economy, law, science, politics, culture, idioms |

Each level starts with grammar-focused sentences and then moves on to vocabulary-focused topics.

Format, one sentence per line: `English | Dutch | other accepted Dutch | …`. Lines starting with `#` are topic headings. New sentences are introduced in file order.

## Speech

- **Listening** uses the browser's own text-to-speech. Audio buttons only appear if a real Dutch (nl-NL / nl-BE) voice is installed. Chrome and Edge include good ones. On a Mac or iPhone, add one in *System Settings → Accessibility → Spoken Content → Manage voices → Dutch*.
- **Speaking** uses the browser's speech recognition (Chrome, Edge, Safari). It tells you which words a Dutch recogniser understood. It doesn't score individual sounds, but if a word doesn't come across, that usually points at the sound to work on.

## Progress

Progress is saved in your browser's local storage, on this site only. Use **Settings → Export backup** now and then, and use **Import** to move to another device.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. It needs a server because the sentence files are fetched.
