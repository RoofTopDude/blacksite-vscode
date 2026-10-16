# Baselines

Dated scorecard summaries, named `<date>-<commit>.summary.json`.

## Replay

`npm run eval:baseline` writes these. The `baseline` arm (`workContracts: off`) replays the orchestration exactly as it behaved before work contracts. The shadow-parity check (observe equals baseline) holds on every commit. So the baseline can be re-measured on any later commit, not only the one before an addition landed.

## Live

No live baseline has been captured yet. Capturing one requires a provider key and spends money. To capture one:

```
BLACKSITE_EVAL_API_KEY=… BLACKSITE_EVAL_MAX_USD=5 \
  npm run eval:live -- --scenario <name> --arms baseline,enforce --repeats 3
```

Then copy `eval-results/live-*/summary.md` here as `<date>-<commit>-<scenario>-live.md`. Note the provider and model in the file.
