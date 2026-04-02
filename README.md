<p align="center">
  <img src="src/logo.svg" alt="Contourist" width="80" height="80">
</p>

<h1 align="center">Contourist</h1>

<p align="center">
  A browser-based topographic joy plot generator.
  <br>Pick a spot on Earth, pull real elevation data, tweak it until it looks cool, and export.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/github/license/null-jones/contourist?style=flat-square&color=0f3460">
  <img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/null-jones/contourist?style=flat-square&color=16213e">
</p>

---

## What is this?

Contourist fetches real-world elevation data from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) and renders it as a ridge plot (aka joy plot) inspired by the Joy Division *Unknown Pleasures* album cover. Everything runs client-side -  no API keys, no accounts, no backend.

**[Try it now](https://null-jones.github.io/contourist/)**

## Features

- **Interactive map** for selecting any bounding box on Earth (Shift+drag to draw)
- **Location presets**: Banff, Mt Everest, Crater Lake, Norwegian Fjords, Innsbruck, Sossusvlei
- **Real elevation data** via AWS Terrain Tiles (Terrarium encoding, no API key needed)
- **Extensive controls**: line count, spacing, amplitude, smoothing, transect angle, stroke width, fill opacity, interpolation mode, horizontal offset, padding, inset, and more
- **Title & subtitle** with 10 Google Fonts options and top/bottom placement
- **Canvas size presets**: Instagram square, 1080x1350, HD, A4 portrait/landscape
- **Export as SVG, PNG, or JPG** at 1x-4x resolution with embedded fonts
- **Auto-scaling** so the plot always fits the canvas regardless of parameter combos

## Quick start

Go to **[null-jones.github.io/contourist](https://null-jones.github.io/contourist/)**.

## How it works

1. You select a geographic bounding box (via presets, map drawing, or manual coordinates)
2. Contourist calculates which [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) cover that area and fetches them as PNG images
3. Each pixel's RGB values are decoded using the Terrarium formula: `elevation = (R * 256 + G + B / 256) - 32768`
4. The raw elevation grid is resampled (with optional rotation for transect angle), normalized to [0, 1], and smoothed
5. Each row becomes a ridge line rendered as an SVG path using Catmull-Rom to Bezier conversion
6. Occlusion is handled by drawing a separate fill polygon (background color, no stroke) behind each ridge line's stroke path

## Project structure

```
contourist/
  index.html      HTML shell: controls, map, layout
  style.css       All styling, CSS variables for theming
  app.js          Application logic: rendering, tile fetching, map, export
  logo.svg        Logo / favicon
  robots.txt      Crawl rules
  sitemap.xml     Sitemap for search engines
  llms.txt        Project description for LLM discoverability
```

## Contributing

Contributions are absolutely welcome.

