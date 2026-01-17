## Dev dataset sync

This project can sync trainer datasets directly into the repo during development.

### Enable

1. Start the dev server with `VITE_ENABLE_TRAINER_SYNC=1`.
2. Open `trainer.html?trainer=1`.
3. Toggle **Sync dataset to repo (dev)** in the Dataset panel.

### Output

Synced files land in:

```
ml/datasets/active/
  dataset.json
  manifest.json
  images/{sampleId}.png
  labels/{sampleId}.json
```

### Notes

- Sync is incremental; only new or updated samples are sent.
- `dataset.json` intentionally excludes raw lat/lon coordinates.
