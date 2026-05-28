# Working style

Emily brings the ideas and designs; you execute.

- Don't ask "should I commit?" or "want me to push?" — just do it for reversible work.
- Skip clarifying questions when you can make a reasonable guess. Mention any assumptions in your reply so I can correct course.
- Default to action: make the change, commit, push, then summarize briefly.
- Keep replies short. The work is in the code, not the explanation.
- Pause and confirm before: force-pushing, deleting branches, sending messages on my behalf, anything that costs money, anything truly irreversible.
- Don't recommend running ultrareview or other paid review tools unless I ask.
- When you finish a task, end your turn after summarizing — don't ask "anything else?".

# About this project

Mouth Munch — an AR/PWA game where the player opens their mouth to "eat"
flying emojis. Built for Emily and her 6-year-old son. Eventually
heading to the iOS App Store at $1.99 via Capacitor.

- Pure static web app: `index.html`, `style.css`, `game.js`, plus PWA bits
  (`manifest.webmanifest`, `sw.js`, `icons/`).
- Face tracking via MediaPipe Face Landmarker (CDN), mouth-open from the
  `jawOpen` blendshape with a lip-gap fallback.
- Deployed to two places, both auto-deploy on push:
  - GitHub Pages: `https://emilyhsiaoluu.github.io/Ar-video-game/`
    (case-sensitive — capital A in path).
  - Vercel: `https://ar-video-game.vercel.app/`.
- When shipping shell changes, bump `VERSION` in `sw.js` so caches refresh.
- Keep the kid-friendly tone: bright, big buttons, generous eat zone.
