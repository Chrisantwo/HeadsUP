# Demo Scenario (historical replay) — Design

**Date:** 2026-08-04
**Status:** Approved

## Goal

Prove, during the thesis defense (when no live typhoon may exist), that HeadsUp
**alerts and notifies** users when a typhoon approaches/enters the PAR and heads
toward **Naga City**. Do this by replaying a **real historical typhoon** through
the app's existing alert/notification pipeline on **both web and mobile**.

Chosen storm: **GONI (Rolly) 2020** — a super typhoon whose real track
(`wp_2020_data.json`) approaches from the Pacific, enters PAR at step 34, and
passes ~41 km from Naga near peak intensity at step 55.

## Principle

Do **not** fake the alerts. Feed a real storm through the real pipeline so the
system genuinely reacts (`computeParAlerts` → `watch/approaching/inside` →
TCWS + notification). That is what proves the feature works.

## Backend (shared)

`GET /api/scenario?name=goni`

- Reads GONI from `backend/data/wp_2020_data.json`.
- Returns the track normalized to the live-storm schema: a list of points
  `{lat, lon, pressure, wind_speed}` and, per step, the **Random Forest**
  category computed by `_classify_intensity_rf(path[:i+1])`.
- Response: `{ status, name, source: "DEMO", points: [...], categories: [...] }`.
- One implementation serves both web and mobile.

## Web

- A labeled **"Demo Scenario" button** that opens a small control (storm = GONI,
  ▶ Play / ⏸ Pause / ⏭ Step, 1× / 4× speed).
- A demo playback controller that, while active:
  - suppresses the live storm feed,
  - at step `i` injects a demo storm (position `points[i]`, trail
    `points[0..i]`, category `categories[i]`) into the same `storms` state that
    `HurricaneTracker`, `computeParAlerts`, and `useParBroadcastEngine` consume,
  - fetches the LSTM forecast for the partial track (throttled) so the 7-day
    line points toward Naga.
- The existing alert banner + browser push + TCWS fire on their own.

## Mobile

- A **Demo Scenario control** (button/screen) wired into `StormDataProvider`
  (`useStormData`).
- While active, the provider suppresses the live fetch and injects the same demo
  storm into `storms`/`alerts`; on the `inside`-PAR transition it calls
  `scheduleLocalNotification(...)` → a real phone notification. Map/alerts/impact
  tabs update as normal.

## Honesty

- Persistent banner while active on both platforms:
  **"🎬 DEMO SCENARIO — historical replay: GONI (Rolly), Nov 2020."**
- Storm tagged `source: "DEMO"`; turning the demo off restores the live feed.

## Out of scope

- Additional storms (GONI only for now).
- Any change to the trained models or the live-data path.

## Verification

- Backend: endpoint returns GONI with sane per-step RF categories.
- Web/mobile: typecheck; stepping to PAR-entry step raises an `inside`/
  `approaching` alert, and the Naga-closest step raises high TCWS + a
  notification.
