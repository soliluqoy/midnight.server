# midnight.server desktop concept

## Walkthrough

Open [`walkthrough.html`](./walkthrough.html) in a browser. It is a self-playing walkthrough (about 2:10) on a simulated Windows desktop, in eleven chapters: resting capsule, a work request, plan, files (computer use), browser, connectors (MCP), approval at the edge, receipts, a cited web-search answer, parallel missions (errand, work, monitor), and back to quiet. Every request appears as a large "You asked" card labeled Work, Question, Errand or Monitor. Subtitles are on by default; "Turn on voice and sound" adds a calm, warm, matter-of-fact narration pre-recorded with the open-source Kokoro model (voice: Heart) and embedded in the page, with the browser's speech as a fallback; the film waits for each line to finish. A full narration transcript sits below the chapter list, plus a synthesized sound theme. `Space` plays or pauses, `←`/`→` change chapters, and in chapter 7 the viewer chooses whether the email is sent.

## Presentation

Open [`presentation.html`](./presentation.html) in a browser. It is a self-contained, animated 10-slide product presentation.

- `ArrowLeft` / `ArrowRight` or `Space`: navigate
- `P`: print or export to PDF
- Buttons on the first and final slides: jump through the story

The visual language follows the midnight website: DM Sans, Fraunces, DM Mono, dark midnight surfaces, lavender, pink, blue and green accents, rounded cards, and a quiet star field.

## Presentation arc

1. The product shift: terminal to companion
2. The floating mission surface
3. Visible progress and computer-use activity
4. Computer, browser and MCP capabilities
5. Safety and human control
6. Ambient, focus and handoff modes
7. Native shell plus existing agent core
8. Evidence-driven roadmap and rewrite gate
9. Product invitation

## Demo scenario

“Find the latest sales sheet, summarize it, make a chart, and draft an email. Do not send.”

The scenario demonstrates planning, file inspection, browser observation, MCP activity, visible progress and an approval boundary without pretending that external actions are invisible.

## Short-video adaptation

The deck can be recorded as a 60–90 second product film:

- 0–08s: quiet desktop; summon the midnight capsule
- 08–18s: prompt appears and becomes a four-step mission
- 18–38s: timeline shows file, browser and MCP work in parallel
- 38–50s: live screenshot and generated chart appear
- 50–65s: email draft pauses at “send”; approval boundary is explicit
- 65–78s: mission collapses back into the ambient capsule
- 78–90s: “Tell midnight.server what matters.”

The HTML animation is the source-of-truth storyboard for a later screen recording or motion-design render.
