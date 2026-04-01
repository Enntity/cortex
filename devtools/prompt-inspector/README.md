# Prompt Inspector

Local-only prompt debugging UI for `run.log`.

## Run

```bash
cd /Users/jmac/software/ml/enntity/cortex
npm run prompt-inspector
```

Then open:

```text
http://127.0.0.1:4317
```

## Environment

- `PROMPT_INSPECTOR_PORT`: override port, default `4317`
- `PROMPT_INSPECTOR_HOST`: override host, default `127.0.0.1`
- `PROMPT_INSPECTOR_LOG`: override log path, default `./run.log`
- `PROMPT_INSPECTOR_MAX_REQUESTS`: max parsed prompt entries, default `200`

## What It Shows

- Route, runtime, synthesis, and continuity prompt entries found in `run.log`
- Sectioned prompt view with approximate token and character counts
- Cacheability hints: `static`, `semi-stable`, `volatile`, `schema`
- Raw provider payload for copy/paste and debugging
