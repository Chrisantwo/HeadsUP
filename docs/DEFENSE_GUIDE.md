# HeadsUp — Thesis Defense Guide

A practical guide to explaining and defending HeadsUp. It gives you the pitch,
simple explanations of the ML, the exact numbers to cite, a question-and-answer
bank for the panel, an honest list of limitations, and a live-demo script.

**Golden rule of a defense: be honest and precise.** You do not need the system
to be perfect — you need to *understand* it and *state clearly* what it does,
how well, and where its limits are. Panelists reward students who know their own
system's boundaries. This guide is written so every answer you give is true.

---

## 1. The 30-second pitch

> "HeadsUp is a real-time typhoon monitoring and 7-day forecasting system for the
> Philippine Area of Responsibility, with hyperlocal hazard detail for Naga City.
> It uses two machine-learning models: an **LSTM** that forecasts the storm's
> **track** — where it will go — and a **Random Forest** that classifies the
> storm's **intensity** — how strong it is. It pulls live storm data and live
> weather, runs the forecast, and shows the track, wind signals, and flood/surge
> risk on a web and mobile app."

**Two ML models, two questions:**
- **LSTM → "Where will it go?"** (the track)
- **Random Forest → "How strong is it?"** (the category: TD, TS, TY, … STY)

Memorize that sentence. Most follow-up questions branch from it.

---

## 2. Why this matters (significance)

- The Philippines is hit by ~20 tropical cyclones a year; the Bicol Region
  (Naga City) is highly exposed.
- Official forecasts are national/regional. HeadsUp adds a **hyperlocal**
  layer — barangay-level flood and storm-surge risk for Naga — on top of a
  real 7-day track forecast, in one accessible web + mobile interface.
- The goal is **decision support for preparedness** (evacuation, warnings), not
  to replace PAGASA — a point worth stating explicitly (see Q "How is this
  different from PAGASA?").

---

## 3. Explaining the LSTM (in plain terms)

**What an LSTM is (one sentence):** a type of neural network designed for
*sequences* — it looks at a series of past steps and predicts the next one,
which fits a storm track (a sequence of positions in time).

**How we use it:** we feed the last 24 hours of the storm (8 three-hour steps),
each described by 4 numbers — latitude, longitude, pressure, wind — and it
predicts the next step. We repeat that 56 times to build a 7-day track.

**The one clever design choice — say this, it impresses panels:**
> "A plain LSTM that predicts the next absolute position actually performed
> *worse* than a simple 'keep going the same way' baseline, because its own
> small errors compound over a 7-day rollout. So I redesigned it as a
> **hybrid**: the LSTM predicts only a **correction** to a physics-based
> persistence forecast. The physics carries the trajectory; the LSTM nudges it.
> That's what made it beat the baseline at the short lead times that matter for
> warnings."

`next_position = physics_persistence + LSTM_correction`

**Why that's defensible:** it's an honest, standard technique (residual/hybrid
modeling), and you can show the before/after numbers proving it helped.

---

## 4. Explaining the Random Forest (in plain terms)

**What a Random Forest is (one sentence):** an ensemble of many decision trees
that vote on a category; it's robust and works well on tabular features.

**How we use it:** from the storm's recent track we compute 9 features
(position, wind, pressure, how fast the wind/pressure are changing, translation
speed, etc.) and the forest classifies the storm into one of 6 intensity
categories: TD, TS, TY, SevTY-3, SevTY-4, STY.

**Where it runs:** live — every time the app refreshes active storms (every 10
minutes), the Random Forest classifies each one, and that category is the badge
you see on the map. (Storms with too little history — fewer than 5 fixes — fall
back to a wind-speed rule using the same category thresholds.)

---

## 5. The numbers to memorize

**LSTM track skill** (held-out test storms 2023–2025, 67 storms). Skill > 0
means it beats the persistence baseline:

| Lead time | LSTM error (RMSE) | Baseline error | Result |
|-----------|------------------:|---------------:|--------|
| 6 hours | 47 km | 60 km | **22% better** |
| 12 hours | 107 km | 129 km | **17% better** |
| 24 hours | 244 km | 268 km | **9% better** |
| 48 h+ | — | — | roughly tied / physics slightly better |

> One-liner: *"The LSTM improves the 0–24-hour track forecast by 9–22% over the
> baseline — the window that matters most for evacuation decisions."*

**Random Forest intensity accuracy** (held-out test set, ~3,500 samples):
- **~90% overall accuracy**, **~0.80 macro F1**.
- Very strong on common classes (TD/TS/TY ≈ 0.85–0.96 F1); weaker on the rare
  Super Typhoon class (low recall — few training examples).

**Data:** trained on Western Pacific tracks **2013–2022**, tested on **2023–2026**
(a clean chronological split — see the data-leakage question).

---

## 6. Panel Q&A bank (with honest answers)

### On the models

**Q: Why an LSTM for the track?**
> Storm tracks are time sequences, and LSTMs are built for sequences — they
> carry memory of the recent motion. That's a natural fit for predicting the
> next position from the last several.

**Q: Why did your LSTM only beat physics at short lead times?**
> Because the forecast is autoregressive — it feeds its own predictions back in —
> so errors compound over 7 days. At long range, no simple model beats the
> strong momentum of a storm, so physics persistence is competitive. My
> contribution is the short-to-medium range (0–24 h), which is exactly the
> window used for warnings. I report this honestly rather than claiming it wins
> everywhere.

**Q: Isn't the Random Forest just doing what a wind-speed threshold does?**
> The category *boundaries* align with wind thresholds, but the Random Forest
> uses 9 features — including how fast the wind and pressure are *changing* and
> the storm's motion — so it captures intensification/weakening trends, not just
> the current wind. It reaches ~90% accuracy against the labeled categories. For
> brand-new storms with too little history, I deliberately fall back to the
> simple threshold, and I tag which method was used.

**Q: Why residual-over-physics instead of a pure LSTM?**
> I tried the pure LSTM first — it lost to a trivial persistence baseline at
> every lead time because errors compounded (−0.38 skill at 6 h). Letting the
> LSTM correct a physics baseline turned that into +0.22 at 6 h. It's an honest,
> reproducible improvement, and the backtest shows the before/after.

**Q: Why is the wind-field (the arrows) physics and not ML?**
> The track and intensity are the ML contributions. The wind *field* around the
> storm is rendered with a standard Rankine-vortex model — a well-established
> physical model. I chose not to claim ML there because I didn't train a model
> for it; being precise about that is important.

### On data & evaluation

**Q: What's your train/test split? How do you avoid data leakage?**
> A chronological split: train on 2013–2022, test on 2023–2026. The model never
> sees the test years during training, and because it's split by time (not
> random), there's no leakage of future information into the past.

**Q: How did you measure track accuracy?**
> Great-circle (haversine) distance in km between the predicted and actual
> position at each lead time, aggregated as RMSE/MAE over 67 held-out storms.
> Critically, the backtest calls the *same* forecast function the live app uses,
> so the reported numbers reflect the deployed system, not an idealized one.

**Q: The Super Typhoon recall is low (0.45). Why, and is that a problem?**
> It's the rarest class — only ~142 test samples — so the model sees few
> examples. I used class balancing to help, and precision on that class is
> actually high (0.94). I'm transparent about this limitation; for a safety
> system, I'd rather report it than hide it.

**Q: Where does your data come from?**
> Historical Western Pacific best-track records (2013–2026) for training; live
> storm fixes from PAGASA/JTWC/JMA feeds; and live weather from Open-Meteo. The
> app degrades gracefully to local fallbacks if a live source is down.

### On scope & positioning

**Q: How is this different from PAGASA / official forecasts?**
> It's decision *support*, not a replacement. My additions are: (1) a 7-day ML
> track forecast, (2) live ML intensity classification, and (3) a hyperlocal
> barangay-level flood/surge layer for Naga that national bulletins don't
> provide — all in one web + mobile app.

**Q: Is this actually usable / deployed?**
> Yes — it runs as a web dashboard and an Expo mobile app against a Flask
> backend, with live data. I can demo it now.

**Q: What happens when a storm just formed and has almost no data?**
> With a single fix there's no motion to learn from, so I seed a nominal
> climatological heading (typical WNW drift) and flag it as an assumption. Once a
> second real fix arrives, it uses the storm's actual motion. Intensity for such
> storms falls back to the wind-speed rule.

### Curveballs

**Q: What would you improve with more time?**
> Three things: (1) train a proper ML wind-field model to replace the Rankine
> physics; (2) more data / augmentation for the rare Super Typhoon class; (3)
> extend the LSTM's long-range skill, possibly with a direct multi-horizon model
> instead of autoregressive rollout.

**Q: Why these algorithms and not deep learning for everything / a transformer?**
> The dataset size (thousands of track segments) suits an LSTM for sequences and
> a Random Forest for tabular classification — both are strong, well-understood,
> and fast enough to run live. A transformer would need more data to justify.
> Matching model complexity to data size is a deliberate choice.

---

## 7. Honest limitations (state these before they ask)

Presenting limitations *first* signals maturity. Frame each with a mitigation:

| Limitation | Honest framing + mitigation |
|-----------|------------------------------|
| LSTM only beats baseline at 0–24 h | That's the warning-critical window; long-range TC forecasting is hard for any simple model. |
| Super Typhoon recall is low | Rarest class, few samples; used class balancing; precision is still high; disclosed openly. |
| Wind-field is physics, not ML | Track + intensity are the ML contributions; wind field uses a standard vortex model — stated plainly. |
| New storms use an assumed initial heading | Flagged as an assumption; corrected once real motion is available. |
| Depends on external live feeds | Graceful fallbacks to local data keep the app working offline. |

---

## 8. Live demo script (5 minutes)

1. **Open the dashboard.** "This is live data — active Western Pacific storms."
2. **Point to a storm badge.** "This category comes from the Random Forest
   classifier." (Mention `category_source: random_forest` if asked how you know.)
3. **Show the forecast track.** "This dashed 7-day track is the LSTM's output,
   stepping every 3 hours out to 168 hours."
4. **Scrub the timeline.** Show the weather layers and the **7-day daily cards**
   (real Naga City forecast).
5. **Open My Area / hazard layer.** Show barangay-level flood/surge risk.
6. **(Optional) Analytics page.** Show the backtest metrics — "this is the
   measured accuracy of the models on held-out storms."

**Backup if live data is empty:** have a screen recording or screenshots ready;
storms aren't always active. Say so honestly if it happens.

---

## 9. How to prove your claims (if challenged)

- **"Show me the accuracy."** → `backend/results/backtest_summary.txt` and the
  Analytics page.
- **"Reproduce it."** → `python backend/scripts/backtest.py` regenerates the
  numbers; `python backend/scripts/train_lstm.py` retrains the LSTM.
- **"Is the LSTM really running?"** → the forecast response includes
  `method: "ml"`; the code path is `ai_models.run_forecast`.
- **"Is the RF really running live?"** → each storm carries
  `category_source: "random_forest"`.

---

## 10. Phrases to use (and to avoid)

**Use — confident and precise:**
- "The LSTM improves the 0–24-hour track by 9–22% over the baseline."
- "I evaluated on held-out storms the model never saw during training."
- "The wind field is a physics model; the ML contributions are track and intensity."
- "Here's a limitation, and here's how I handled it."

**Avoid — overclaiming:**
- "It's 90% accurate" *without* saying at what and on what data. (Be specific:
  the *intensity classifier* is ~90% on the held-out test set.)
- "It predicts typhoons perfectly / better than PAGASA."
- "Everything uses AI." (The wind field and single-fix heading do not.)

---

## 11. One-page cheat sheet

- **What:** real-time typhoon monitoring + 7-day forecast + hyperlocal Naga hazard.
- **LSTM:** track (where). Hybrid residual-over-physics. Beats baseline 9–22% at 0–24 h.
- **Random Forest:** intensity (how strong). ~90% accuracy, ~0.80 macro F1. Runs live.
- **Data:** WP tracks 2013–2022 train / 2023–2026 test (chronological, no leakage).
- **Live:** PAGASA/JTWC/JMA storms + Open-Meteo weather; graceful fallbacks.
- **Not ML (be honest):** wind-field arrows (Rankine physics); new-storm heading (climatology).
- **Stack:** Flask backend, Next.js web, Expo mobile.
- **Reproduce:** `backtest.py` (metrics), `train_lstm.py` (retrain).

Good luck — you know this system. Answer plainly, cite the numbers, own the
limits.
