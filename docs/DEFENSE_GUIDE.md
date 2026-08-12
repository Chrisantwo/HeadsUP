# HeadsUp — Defense Guide (Explained Simply)

This guide explains HeadsUp in the **simplest possible way** so you can confidently
explain and defend it. No jargon walls — plain words, everyday comparisons, and
the exact numbers to say.

**The one rule for your defense:** be honest and clear. You don't need a perfect
system. You need to *understand it* and *explain it plainly*. Everything in this
guide is true to what the app actually does.

---

## 1. What is HeadsUp? (one breath)

> "HeadsUp is a typhoon app for the Philippines. It watches live storms, predicts
> where each storm will go for the next 7 days, says how strong it is, and shows
> the flood and storm-surge risk for Naga City — all on a website and a phone app."

Two smart parts do the predicting:
- **LSTM → predicts WHERE the storm goes** (the path/track).
- **Random Forest → predicts HOW STRONG the storm is** (the category).

Remember this: **LSTM = where. Random Forest = how strong.** Almost every
question comes back to these two.

---

## 2. How the app works (step by step, simply)

Think of it as an assembly line:

1. **Get the live storm.** The app pulls real storm positions from weather
   agencies (PAGASA, JTWC, JMA) every 10 minutes.
2. **Predict the path (LSTM).** It feeds the storm's recent movement into the
   LSTM, which draws the next 7 days of the storm's path — one point every 3
   hours.
3. **Predict the strength (Random Forest).** It looks at the storm's recent
   numbers and decides its category (Tropical Depression → Super Typhoon).
4. **Add the weather.** It pulls live weather (rain, wind, temperature) from a
   free weather service (Open-Meteo) and shows it as map layers.
5. **Compute local risk.** For Naga City, it calculates flood and storm-surge
   risk down to the barangay level.
6. **Show it.** All of this appears on the web dashboard and the mobile app —
   the storm marker, the 7-day track line, the category badge, and the risk.

That's the whole pipeline: **live data → LSTM path → Random Forest strength →
weather + local risk → shown on screen.**

---

## 3. How the LSTM works (simply)

**What it does:** predicts where the storm will be next.

**Everyday comparison:** Imagine watching a car drive down a road. From how it's
been moving the last few seconds, you can guess where it'll be a moment later.
The LSTM does that for storms — it looks at the last 24 hours of the storm's
movement and guesses the next position, then repeats to build a 7-day path.

**What it looks at:** the last 8 recent points of the storm (one every 3 hours =
24 hours), each with 4 numbers: latitude, longitude, air pressure, and wind
speed.

**The clever trick (say this — it sounds smart and it's true):**
> "At first my LSTM tried to guess the storm's exact next position, but its small
> mistakes piled up over 7 days and it did worse than a simple 'keep going the
> same way' guess. So I changed it: the LSTM now starts with that simple guess and
> only makes a **small correction** to it. The simple guess keeps the storm on
> track; the LSTM just fine-tunes it. That's what made it accurate."

In one line: **LSTM's answer = simple 'keep going' guess + a small smart
correction.**

**Why an LSTM?** It's a type of AI built for *sequences* (things in order over
time) — and a storm track is exactly that: a sequence of positions.

---

## 4. How the Random Forest works (simply)

**What it does:** decides how strong the storm is (its category).

**Everyday comparison:** Imagine asking 200 weather experts to each look at the
storm and vote on its strength. Some look at wind, some at pressure, some at how
fast it's changing. Then you go with the majority vote. A Random Forest is
exactly that — 200 small "decision trees" that each vote, and the majority wins.
"Forest" = many trees.

**What it looks at (9 clues):** the storm's position, wind, pressure, how fast
the wind is changing, how fast the pressure is changing, how fast the storm is
moving, and the time of day.

**The categories it picks from:**
TD (Tropical Depression) → TS (Tropical Storm) → TY (Typhoon) → SevTY-3 →
SevTY-4 → STY (Super Typhoon).

**Where it runs:** live. Every 10 minutes when the app refreshes storms, the
Random Forest re-checks each storm's category. (If a storm just formed and has
almost no history, the app uses a simple wind-speed rule instead, until there's
enough data for the forest.)

---

## 5. How did the app get its prediction results? (very important)

Panelists love this question: *"How do you know your predictions are any good?"*
Here's the simple, honest answer.

**The method — learn from the past, test on the future:**

1. **Teach the models with OLD storms.** We used real Western Pacific storms from
   **2013 to 2022** to train both models. This is where they "learned" the
   patterns.
2. **Test with NEWER storms they had never seen.** We then checked them on storms
   from **2023 to 2026** — storms that were *not* used in training. This is a fair
   test, like a student taking an exam on questions they didn't study the answers
   to beforehand.
3. **Measure how close the guesses were.**
   - For the **LSTM (path)**, we measured the distance (in kilometers) between the
     predicted position and where the storm *actually* went.
   - For the **Random Forest (strength)**, we counted how often its category
     matched the real category.

**Why split by time (2013–2022 train, 2023–2026 test)?** So the model can't
"cheat" by having seen the test storms. It only ever learned from the past and
was tested on the future — no leakage.

**One more honesty point:** the test uses the *same* prediction code the live app
uses. So the reported accuracy is the real app's accuracy, not a lab-only number.

---

## 6. The results (numbers to say, explained simply)

### LSTM (path) — how close were the guesses?

We compare the LSTM to a "dumb" baseline that just assumes the storm keeps moving
the same way. **Positive skill = the LSTM is better.**

| How far ahead | LSTM is off by | Baseline is off by | LSTM is… |
|---------------|---------------:|-------------------:|----------|
| 6 hours | ~47 km | ~60 km | **22% better** |
| 12 hours | ~107 km | ~129 km | **17% better** |
| 24 hours | ~244 km | ~268 km | **9% better** |
| 2+ days | (grows) | (grows) | about tied |

**Say this:** *"My LSTM is 9–22% more accurate than the baseline for the first
24 hours — the window that matters most for warnings. Beyond that, all simple
models struggle, and I report that honestly."*

### Random Forest (strength) — how often right?

- **About 90% accurate** at picking the right category.
- Excellent on common storms (Depression, Storm, Typhoon).
- Weaker on the rarest "Super Typhoon" class — because there are very few of them
  to learn from (be honest about this).

---

## 7. Quick answers to likely questions

**Q: Which parts are AI, and which are not? (be honest)**
> The **track (LSTM)** and the **strength (Random Forest)** are the AI. The little
> wind arrows around the storm are a standard physics formula, not AI. And for a
> brand-new storm with no movement yet, the starting direction is an assumption I
> flag. I'm upfront about all of this.

**Q: Is the physics engine what runs, or the AI?**
> The AI runs. The app checks: are the trained models there? Yes — so it uses the
> LSTM and Random Forest. There's a physics backup that only switches on if the
> AI files are deleted. In normal use it never runs. I can prove it live — the
> app reports `method: ml`.

**Q: Isn't the Random Forest just a wind-speed rule?**
> The categories line up with wind levels, but the forest also uses *trends* —
> whether the storm is strengthening or weakening — so it's smarter than a fixed
> rule. It's ~90% accurate. Only for brand-new storms with no history do I fall
> back to the simple rule.

**Q: Why does the LSTM only win at short range?**
> Because it predicts step by step, and tiny errors add up over 7 days. Nobody's
> simple model beats a storm's momentum at long range. My gain is in the first
> 24 hours — the useful window for warnings.

**Q: How is this different from PAGASA?**
> It's a helper, not a replacement. My extras are: a 7-day AI track, live AI
> strength classification, and Naga barangay-level flood/surge risk in one app.

**Q: How did you avoid cheating in the test?**
> I trained on 2013–2022 and tested on 2023–2026 — different storms, split by
> time, so the model never saw the test storms while learning.

**Q: Biggest limitations?**
> Long-range track is hard; the rare Super Typhoon class has few examples; and the
> wind-field arrows are physics, not AI. I know these and can explain each.

---

## 8. Live demo (5 minutes)

1. Open the dashboard — "these are real, live storms."
2. Point to a storm's category badge — "this comes from the Random Forest."
3. Point to the dashed 7-day line — "this is the LSTM's path prediction."
4. Slide the timeline — show weather layers and the 7-day Naga forecast cards.
5. Open My Area — show barangay flood/surge risk.
6. (Optional) Analytics page — "this is the measured accuracy on test storms."

*If no storms are active that day, have screenshots or a screen recording ready,
and just say so honestly.*

---

## 9. One-page cheat sheet

- **What it is:** live typhoon app — 7-day track + strength + Naga flood/surge risk.
- **LSTM = WHERE.** Learns from past storms; predicts the path; "keep-going guess +
  small correction." **9–22% better than baseline in the first 24 h.**
- **Random Forest = HOW STRONG.** 200 voting trees; picks the category;
  **~90% accurate.** Runs live.
- **How tested:** trained on 2013–2022 storms, tested on unseen 2023–2026 storms;
  measured distance error (track) and match rate (strength).
- **Honest bits:** wind arrows = physics (not AI); brand-new storm heading = an
  assumption; physics engine = backup only, not normally used.
- **Stack:** Flask backend, Next.js website, Expo mobile app; live storm + weather
  data.

**Final reminder:** speak plainly, say the numbers, admit the limits. You know
this system — that's what wins a defense.
