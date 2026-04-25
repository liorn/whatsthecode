# What's the Code

A tiny, mobile-first web app that shows the entry code of the building you're standing next to.

Save an entry once — a name, a numeric code (with `#` / `*`), and an address — and the home screen automatically surfaces the nearest saved code based on your current GPS. Tap the code to copy it. Use the `‹` / `›` pager if the top match isn't the one you wanted.

Live at: **https://whatsthecode.lior.dev**

## Features

- **Nearest-code home**: one big, tappable code for the closest saved address. Page through the rest in order of distance.
- **Autocomplete address entry**: type an address, pick a match from OpenStreetMap Nominatim; lat/lng are stored so "nearest" works.
- **"Use my current location"**: prefills the address form by reverse-geocoding your GPS.
- **Everything is local**: entries live in your browser's `localStorage`. No account, no server of our own.

## Stack

- Vanilla HTML / CSS / JS — no build step, no framework.
- Browser Geolocation API with a low-first strategy (coarse WiFi/cell fix, falling back to GPS).
- [Nominatim](https://nominatim.openstreetmap.org/) for address search + reverse geocoding.
- Hosted on GitHub Pages.

PWA manifest and service worker are in the repo but currently unlinked from `index.html` — re-enable for installability + offline once the app is stable.

## Run locally

Geolocation requires a secure context — either `localhost` or HTTPS.

```sh
# Simple static server, any one works:
python3 -m http.server 8080
#   or
npx serve
#   or, with live-reload while you edit:
npx live-server --port=8080
```

Then open `http://localhost:8080`.

> Testing on a phone? Geolocation only works on `localhost` or HTTPS, so plain HTTP over LAN won't prompt for location. Use a tunneling tool that gives you HTTPS, or deploy a branch to Pages.

## Data model

```ts
// localStorage key: wtc.entries.v1
type Entry = {
  id: string;
  name: string;
  code: string;       // verbatim, including # and *
  address: string;    // Nominatim display_name
  lat: number;
  lng: number;
  createdAt: number;  // epoch ms
};
```

Nothing else is stored. Clear site data to reset.

## Deploy

Any static host works. This repo is deployed via GitHub Pages from `main` at the repo root, with a custom domain in `CNAME`.

## Privacy

- No analytics, no third-party trackers.
- Your entries never leave your browser.
- Address lookups hit Nominatim (OpenStreetMap); only the string you type is sent — not your entry codes, not your saved list.
- GPS coordinates are used client-side to sort entries by distance and are never sent anywhere.
