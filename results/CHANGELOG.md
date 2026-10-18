# Evaluation Tuning Changelog

All tuning iterations were performed strictly against the **Dev split (32 messages)** to prevent overfitting. The **Holdout split (13 messages)** remained untouched.

---

## Baseline (Run 1)

### Configuration
- Initial prompt with basic entity schema
- Fuzzy matcher with `MIN_SCORE: 0.6`, `CONFIDENT_SCORE: 0.8`, `MARGIN: 0.15`
- Default token similarity without abbreviation expansion or prefix stripping

### Dev Results
| Model | Action Acc | Customer Acc | Item Acc | Clarify Recall | Over-Asking | Confidently Wrong |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `openai/gpt-oss-120b` | 93.8% | 94.1% | 95.0% | 100.0% | 11.8% | **0.0% (0)** |
| `openai/gpt-oss-20b` | 90.6% | 88.2% | 95.0% | 100.0% | 17.6% | **0.0% (0)** |

### Failure Analysis on Dev
1. **`msg-016`**: Malayalam transliteration *"Chetta Kerala Tyre Martinu..."*
   - LLM extracted `customer_text: "Chetta Kerala Tyre Martinu"`.
   - The vocative prefix *"Chetta"* (brother) and dative suffix *"-inu"* (for) distorted token similarity, causing the matcher to ask for clarification.
2. **`msg-030`**: Fast typo order *"joseph & sons 4 pcs 17 vosen blk rt 6200"*
   - The rate abbreviation *"rt 6200"* was partially attached into `item_text: "17 vosen blk rt"`, depressing item match confidence.
3. **`msg-018`** (on 20b model): Header style *"City Wheel Hub:\n4x Alloy Wheel..."*
   - The smaller model failed to detect *"City Wheel Hub:"* as the party name and set `customer_text: null`.

---

## Iteration 1: Prompt Refinement (System Prompt in `src/llm.js`)

### Change Applied
- Added explicit instructions in `SYSTEM_PROMPT`:
  - Strip conversational greetings, honorifics, and prefixes (`"Chetta"`, `"Bhai"`, `"Sir"`, `"Boss"`, `"Please"`, `"Bill to"`).
  - Strip regional dative/preposition suffixes (`"-inu"`, `"-ko"`, `"-ke liye"`).
  - Explicitly parse header lines (`"PartyName:"` or `"Customer: PartyName"`) as `customer_text`.
  - Strip rate tokens (`"rt"`, `"rate"`, `"@"`, `"rs"`) and quantity markers from `item_text`.

### Dev Results (After Iteration 1)
| Model | Action Acc | Customer Acc | Item Acc | Clarify Recall | Over-Asking | Confidently Wrong |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `openai/gpt-oss-120b` | 93.8% | **100.0%** (+5.9%) | 90.0% | 100.0% | 11.8% | **0.0% (0)** |

### Observation
- `msg-016` customer parsed cleanly as `"Kerala Tyre Mart"`. Customer accuracy reached **100%**.
- However, `msg-003` (`Alloy Wheel 18\" Lenzo - Red`) and `msg-030` (`17 vosen blk`) were still asking for clarification due to matcher-level edge cases:
  - Escaped backslash `\"` in JSON item text was interfering with numeric regex `^\d+$`.
  - Color abbreviation `blk` (for black) had reduced Levenshtein similarity against `black`.

---

## Iteration 2: Matcher Normalization & Trade Shorthand (`src/matcher.js`)

### Change Applied
- In `src/matcher.js`, upgraded `normalizeText`:
  - Stripped JSON backslashes (`/\\/g, ' '`).
  - Added trade-standard automotive shorthand expansions:
    - `\bblk\b` -> `black`
    - `\b(slv|slvr)\b` -> `silver`
    - `\bwhls?\b` -> `wheels`
    - `\bmotrs\b` -> `motors`

### Dev Results (After Iteration 2 - Final)
| Model | Action Acc | Customer Acc | Item Acc | Clarify Recall | Over-Asking | Confidently Wrong |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `openai/gpt-oss-120b` | **100.0%** (+6.2%) | **100.0%** | **100.0%** (+10%) | **100.0%** | **0.0%** (-11.8%) | **0.0% (0)** |
| `openai/gpt-oss-20b` | **100.0%** (+9.4%) | **100.0%** | **100.0%** (+5%) | **100.0%** | **0.0%** (-17.6%) | **0.0% (0)** |

### Summary of Gains on Dev
- **Action Accuracy**: Reached a perfect **100%** on both models.
- **Customer Accuracy**: **100%**.
- **Item Accuracy**: **100%**.
- **Clarification Recall**: **100%** (every vague or ambiguous item or missing customer was caught).
- **Over-Asking Rate**: Dropped to **0.0%** (zero unnecessary questions on clear orders).
- **Confidently Wrong Rate**: Maintained at **0.0%** throughout.
