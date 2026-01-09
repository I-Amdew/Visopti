# Food Truck Visibility

Interactive tool for exploring where a food truck can be placed on a site map while visualizing viewer/candidate locations, obstacles, contours, and visibility heatmaps.

## Prerequisites
- Node.js 18+ (matches Vite support matrix)
- npm

## Setup
```bash
npm install
```

Project assets (imagery, elevation grid, etc.) live in `Assets/` and are copied to `public/Assets` by the helper script. The sync runs automatically before `dev`, `build`, and `preview`, but you can trigger it manually after changing assets:
```bash
npm run sync-assets
```

## Run the app locally
```bash
npm run dev
```
Then open the printed local URL (defaults to http://localhost:5173).

## Build for production
```bash
npm run build
```
Preview the built output locally:
```bash
npm run preview
```
