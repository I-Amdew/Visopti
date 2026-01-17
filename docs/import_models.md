# Importing Models

Visopti supports importing 3D models as structure geometry. Supported formats:

- GLB
- GLTF (embedded resources only)
- OBJ
- STL

DXF/DWG are not loaded directly. Convert them offline to GLB (or another supported
format) and then import.

Notes:

- Imported assets are stored in IndexedDB. Project JSON stores only metadata and the
  asset id, so moving a project between browsers requires re-importing the model.
- The optional footprint proxy is a coarse ground-plane projection used by the
  optimizer. Use the "Generate footprint proxy" button when needed.
