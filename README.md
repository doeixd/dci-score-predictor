# dci-score-predictor

Type-safe DCI drum corps score prediction in pure TypeScript. Ships the v10.5
identity-agnostic ensemble model (TensorFlow.js) — no server, no database, no
Python. Runs in Node, Bun, Deno, browsers, and edge workers.

```ts
import * as DCI from 'dci-score-predictor'

const result = await DCI.predict({
  history: /* season results so far */,
  target:  /* the show to predict */,
})
```

Status: pre-release scaffold. See `docs/PLAN.md` for the full design.
