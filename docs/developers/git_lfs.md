# Git LFS for model weights

Model weights are committed to the repo so the web app can load them directly.
Use Git LFS to avoid bloating the main Git history.

## Setup

```bash
git lfs install
git lfs track "*.onnx"
git lfs track "*.pt"
```

Confirm the patterns are in `.gitattributes`, then commit the file.

## Notes

- Weight files live in `public/models/` and `ml/models/`.
- Training outputs write directly to tracked paths, so no manual copying is needed.
