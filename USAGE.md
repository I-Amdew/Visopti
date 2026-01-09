# Usage Guide

## 1) Run the app
```bash
npm install
npm run dev
```
Open the local URL shown in the terminal (usually http://localhost:5173).

## 2) Pick a map frame
1. Pan and zoom the map to the area you want to analyze.
2. Click **Lock frame** to freeze that view.
3. Click **Load topography** (or lock the frame to auto-load).

The canvas will refresh to match the locked map frame.

## 3) Draw zones
Use the **Tools** panel to draw:
- **Viewer zones**: areas where people stand or walk.
- **Candidate zones**: possible truck placements.
- **Obstacle zones**: trees, buildings, or anything that blocks sightlines.

## 4) Compute visibility
- **Compute heatmap**: shows the best placement coverage across the candidate zone.
- **Compute blindspots**: highlights areas not visible from viewer zones.

Adjust sample step size and opacity sliders to control detail and display.

## 5) Save or share work
Export or import a project via the **Project** section. You can also export shapes only if you want to reuse zones elsewhere.

## Tips
- If elevation or map tiles fail to load, try again or check your network access.
- Lock the frame before drawing for the most accurate results.
