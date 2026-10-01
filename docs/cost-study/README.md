# Opus + Flash vs Opus-only — cost study, in plain English

This page records every cost measurement we made on the plugin between 16 and 30 Sep 2026. It covers what each fix changed, what it cost, and what we learned. It is written for anyone on the team, not only people who know the plugin's internals.

The same study as a formatted page: [opus-flash-cost-study.html](opus-flash-cost-study.html) (open it in a browser). The technical plan behind the fixes is [../planning/opus-plus-flash-cost-plan.md](../planning/opus-plus-flash-cost-plan.md).

## The short answer (30 Sep, final)

**Opus + Flash is usually a little cheaper than Opus-only, about 10% on average, but the saving is small and not guaranteed. On big jobs Flash is now slightly ahead too (≈ 8%), after the 0.8.12 check pair.**

After the medium-task pairs (below, 16–25 Sep) we tested the same question on three sizes of job, from 28 to 30 Sep. "Work itself" = the run without our own chat:

| Job size | Pairs | Opus + Flash | Opus-only | Result |
|---|---|---|---|---|
| Small (7 files) | 2 | ≈ $8.69 | ≈ $9.70 | Flash ≈ 10% cheaper (second pair a tie) |
| Medium (14–17 files) | 3 | ≈ $8.14 | ≈ $10.07 | Flash ≈ 19% cheaper |
| Large (25–28 files, two different jobs) | 4 | ≈ $14.32 | ≈ $15.54 | Flash ≈ 8% cheaper (Flash won 3 of 4) |

- **Flash won 6 of the 9 pairs, 1 was a tie, and Opus-only won 2.** Most wins were by $1–3, which is about the size of normal run-to-run noise.
- **Large jobs:** the one big Opus-only win (28% cheaper, pair Large2-A/B) was partly unfair. The Flash run went first and hit a file-format problem (Windows line endings) that the Opus-only run never met. Plugin 0.8.11 fixed it, and on the re-run pair Flash was 14% cheaper ($12.64 vs $14.63). Leave that biased pair out and Flash is ≈ 10% cheaper on large jobs too. A last check pair on 0.8.12 (Large2-E/F, same job plus three docs files) had Flash **37% cheaper** ($10.78 vs $17.09), the widest gap in the study; treat it as one sample, since run-to-run noise on large jobs is a few dollars.
- **Quality was the same on both sides.** Every run passed its tests. Opus-only got more tasks right first time on large jobs (92–96% vs 79–83%) and needed fewer repair rounds. Flash made more small mistakes, but fixing them was still cheaper than having Opus type everything.
- **Speed:** Flash was faster on small jobs (61–66 min vs 70–96). On large jobs both took 74–85 min, apart from Large-A, where Flash took 102 min.
- **Practical advice:** Opus + Flash is a fine default and saves a little. If you have no Gemini key, or a Flash outage would hurt, Opus-only costs only slightly more. Don't expect big savings from delegation alone: most of the saving in this study came from removing Opus overhead, which helped both setups.

### Earlier headline (25 Sep, medium task only)

On plugins 0.8.8 and 0.8.9, Opus + Flash was cheaper than Opus-only on all three medium-task pairs (full bill $9.17 vs $11.60 on average, ≈ 21%; work itself $8.14 vs $10.07, ≈ 19%):

| Pair | Opus + Flash | Opus-only | Result |
|---|---|---|---|
| 0.8.8 (Runs 30 / 31) | $9.79 | $13.98 | Flash 30% cheaper |
| 0.8.9 (Runs 32 / 33b) | $9.36 | $9.55 | tie |
| 0.8.9 (Runs 34 / 35) | $8.37 | $11.28 | Flash 26% cheaper |

## What was measured

- **The task.** Up to 25 Sep, every run did the same job on the Kaneo codebase (an open-source project-management app): *"add a new public profile page with default profile image"*. Each run changed about 11–17 files: an API endpoint, a web page, tests, and translations. It started with `/mmo:brownfield` and ran start to finish with no human stepping in. From 28 Sep we added a small job and two large jobs (see *Small, medium and large jobs* below).
- **The two setups.**
  - **Opus-only**: Claude Opus plans, writes all the code, and reviews it.
  - **Opus + Flash**: Opus plans and reviews, and hands the code-writing to Google's much cheaper Gemini Flash model.
- **Same conditions each time.** Same laptop, same starting code, same wording of the task, same review steps, and the same cache setting ("1-hour memory") on both sides from 23 Sep onwards. Since plugin 0.8.10, 1-hour memory is the default in every shipped policy, so a new user gets the same setting the study measured (before that, Opus-only defaulted to 5 minutes).
- **What "cost" means.** The full bill for the run: every Opus message (the manager plus its helpers: planner, reviewers) plus what Flash cost. The plugin's collector prices each message at the public list price from the Claude Code logs. Where our own chat landed inside a run's time window, we give both the **full bill** and **the work itself**.

### A quick picture of where the money goes

Think of Opus as an expensive project lead who re-reads the whole project notebook before every single action. Flash is a cheap contractor.

- Flash cost **$0.05–$0.66 a run**, under 10 cents in the latest runs.
- **Over 90% of every bill is Opus** reading, re-reading, and planning.
- So the question was never "how do we make Flash cheaper". It was "how do we stop Opus spending so much preparing work for Flash and cleaning up after it". Almost every fix below is about that.

## Every run

"Full bill" is everything in the run's time window. "Work itself" leaves out our own chat that landed in the same window. Where the two are equal, no separate figure was taken.

| Run | Date | Plugin | Setup | Full bill | Work itself | Minutes | Note |
|---|---|---|---|---|---|---|---|
| — | 16–17 Sep | 0.7.3 | Opus-only | $19.16 | — | 48 | starting point |
| — | 16–17 Sep | 0.7.3 | Opus + Sonnet | $23.36 | — | 53 | trial of Sonnet as the worker |
| — | 16–17 Sep | 0.7.3 | Opus + Flash | $26.02 | — | 60 | starting point |
| A | 18 Sep | 0.7.4 | Opus-only | $22.91 | — | 71 | |
| B | 18 Sep | 0.7.4 | Opus + Flash | $20.75 | — | 51 | first Flash win |
| 9 | 18 Sep | 0.7.5 | Opus + Flash | ($24.76) | — | — | invalid: laptop froze mid-run |
| 10 | 18 Sep | 0.7.5 | Opus-only | $17.96 | — | 50 | |
| 11 | 18 Sep | 0.7.5 | Opus + Flash | $17.41 | — | 53 | |
| 12 | 21 Sep | 0.7.7 | Opus + Flash | — | — | — | invalid: an old helper server was running |
| 13 | 21 Sep | 0.7.7 | Opus + Flash | $18.77 | — | 65 | |
| 14 | 21 Sep | 0.7.8 | Opus + Flash | $17.05 | ≈ $15.42 | 38 | |
| 15 | 21 Sep | 0.7.8 | Opus-only | $21.06 | ≈ $20.50 | 36 | unfair: ran Flash-only steps |
| 16 | 21 Sep | 0.7.9 | Opus-only | $14.86 | ≈ $13.70 | 41 | |
| 17 | 21 Sep | 0.8.0 | Opus + Flash | $15.93 | ≈ $14.60 | 43 | setup bug cost ≈ $1.10 |
| 18 | 21 Sep | 0.8.0 | Opus-only | $17.40 | ≈ $16.10 | 45 | same setup as 16: shows the noise |
| 19 | 23 Sep | 0.8.1 | Opus + Flash | $16.12 | ≈ $14.65 | 71 | |
| 20 | 23 Sep | 0.8.1 | Opus + Flash | $13.90 | ≈ $13.33 | 59 | |
| 21 | 23 Sep | 0.8.1 | Opus-only | $17.43 | ≈ $16.47 | 79 | 5-minute memory trial |
| 22 | 23 Sep | 0.8.2 | Opus-only | $10.78 | ≈ $9.93 | 47 | |
| 23 | 23 Sep | 0.8.2 | Opus + Flash | $12.67 | ≈ $11.96 | 53 | |
| 24 | 23 Sep | 0.8.3 | Opus-only | $13.17 | ≈ $11.27 | 57 | |
| 25 | 23 Sep | 0.8.4 | Opus + Flash | $17.52 | ≈ $16.10 | 65 | 3 import-repair rounds |
| 26b | 24 Sep | 0.8.4 | Opus-only | $11.60 | ≈ $10.79 | 50 | Run 26 died after 1 minute |
| 27b | 24 Sep | 0.8.5 | Opus + Flash | $11.94 | ≈ $11.61 | 59 | Run 27 lost to a network outage |
| 28 | 24 Sep | 0.8.6 | Opus + Flash | $15.32 | ≈ $14.91 | 64 | manager paused 3× (≈ $4.10) |
| 29 | 24 Sep | 0.8.6 | Opus-only | $14.18 | ≈ $12.84 | 69 | |
| 30 | 24 Sep | 0.8.8 | Opus + Flash | $9.79 | ≈ $8.79 | 46 | |
| 31 | 24 Sep | 0.8.8 | Opus-only | $13.98 | ≈ $12.65 | 77 | |
| 32 | 24 Sep | 0.8.9 | Opus + Flash | $9.36 | ≈ $8.15 | 61 | Google "too busy" 8× |
| 33b | 24 Sep | 0.8.9 | Opus-only | $9.55 | ≈ $7.37 | 71 | Run 33 stopped by hand |
| 34 | 25 Sep | 0.8.9 | Opus + Flash | **$8.37** | ≈ $7.47 | 47 | cheapest full bill |
| 35 | 25 Sep | 0.8.9 | Opus-only | $11.28 | ≈ $10.20 | 64 | |

Every valid run passed its tests. From Row 4 onwards no run finished with a serious review issue left open; where a reviewer raised one, the run fixed it before finishing.

## Small, medium and large jobs (28–30 Sep)

Same laptop, same 1-hour memory setting, same review steps. Each pair ran the same job twice, once per setup, starting from the same code. "Work itself" leaves out our own chat that landed in the run's time window.

- **Small job:** show a task count and "last updated" on the public project page (7 files).
- **Large job 1:** a project insights page (about 25 files: API, web page, charts, tests, docs).
- **Large job 2:** a team workload page showing who is working on what across a workspace (25 files: API endpoint, an AI-assistant tool, web page with 5 parts, tests, translations, docs).

| Run | Date | Plugin | Job | Setup | Full bill | Work itself | Minutes | Note |
|---|---|---|---|---|---|---|---|---|
| Small-A | 28 Sep | 0.8.10 | small | Opus + Flash | $9.39 | ≈ $8.31 | 61 | |
| Small-B | 28 Sep | 0.8.10 | small | Opus-only | $11.71 | ≈ $10.63 | 96 | reviewer caught a real counting bug |
| Small-C | 28 Sep | 0.8.10 | small | Opus + Flash | $10.09 | ≈ $9.06 | 66 | |
| Small-D | 28 Sep | 0.8.10 | small | Opus-only | $9.98 | ≈ $8.77 | 70 | pair 2 a tie |
| Large-A | 28 Sep | 0.8.10 | large 1 | Opus + Flash | $18.64 | ≈ $17.17 | 102 | 11 checks rewritten by hand (line endings) |
| Large-B | 29 Sep | 0.8.10 | large 1 | Opus-only | $19.31 | ≈ $18.51 | 79 | first attempt stalled; re-run |
| Large2-A | 29 Sep | 0.8.10 | large 2 | Opus + Flash | $18.70 | ≈ $16.68 | 84 | planner spent ≈ $6 shortening its plan and working around line endings |
| Large2-B | 29 Sep | 0.8.10 | large 2 | Opus-only | $14.66 | ≈ $11.94 | 85 | 96% right first try |
| Large2-C | 29 Sep | 0.8.11 | large 2 | Opus + Flash | $13.81 | ≈ $12.64 | 75 | 0.8.11 fixes held |
| Large2-D | 30 Sep | 0.8.11 | large 2 | Opus-only | $15.26 | ≈ $14.63 | 74 | 92% right first try, 0 repair rounds |
| Large2-E | 30 Sep | 0.8.12 | large 2 + docs | Opus + Flash | $11.71 | ≈ $10.78 | 79 | 28 files; 85% right first try, 1 repair round |
| Large2-F | 30 Sep | 0.8.12 | large 2 + docs | Opus-only | $17.77 | ≈ $17.09 | 72 | 28 files; 96% right first try, 0 repair rounds |
| Large2-G | 30 Sep | 0.8.12 | large 2 + docs | Opus-only | $18.15 | ≈ $16.99 | 87 | repeat of Large2-F, to check the $17 wasn't a fluke |

**Pair results (work itself):** Small pair 1 Flash −22%, pair 2 tie · Large 1 Flash −7% · Large 2 pair 1 Opus-only −28% (biased, see Row 20) · Large 2 pair 2 Flash −14% · Large 2 pair 3 (0.8.12, +docs) Flash −37%.

Every run passed its tests and security review. Where a reviewer raised a serious issue, the run fixed it, except in Large2-D: two of its three serious issues needed files the run was not allowed to touch (the API spec `openapi.json` and the assistant-tool lists in the docs). That is a gap in the list of allowed files, not a mistake by the run. Plugin 0.8.12 closed it: Large2-E and Large2-F updated both, and no reviewer raised that issue again.

## What we fixed, row by row

Each "row" is one round of fixes to the plugin, followed by runs to measure it. Each row lists the problem it tackled, what changed, and what the measurements showed.

### Starting point — plugin 0.7.3 (16–17 Sep)

- **Setup:** Opus plans and reviews; a cheaper model (Flash, or Sonnet as a trial) writes the code.
- **Result:** Opus-only $19.16, Opus + Sonnet $23.36, Opus + Flash $26.02. Handing work to Flash made the run **36% more expensive**, even though Flash itself cost 12 cents.
- **Why:** the planner wrote the whole program into its plan (1,011 lines, 62 code blocks). Flash copied it out, and then Opus re-typed and re-read Flash's files. The code was effectively written three times.
- **Earlier findings (before this study):** delegating saved 25–60% on the delegated work itself, not the 10× hoped for. Sonnet was cheaper ($9.91 on a small task) but missed a requirement once, so Opus stayed on planning.

### Rows 1–3 — plugin 0.7.4 (18 Sep): Flash saves and checks its own work

- **Problem:** Opus copied every Flash file into place itself, and re-read it to check it.
- **Fixes:**
  1. Flash's output is written straight to disk by the plugin's server; Opus only reads a short note.
  2. The server runs the checks on Flash's code and asks Flash to retry, without involving Opus.
  3. Opus's memory (the prompt cache) is kept for 1 hour instead of 5 minutes.
- **Runs:** Opus-only $22.91 · Opus + Flash $20.75.
- **Result:** the first win for Flash (9% cheaper). Opus stopped re-typing Flash's files.
- **Still wrong:** Opus-only got dearer (the 1-hour memory costs more for short-lived helpers). Flash could only rewrite whole files, so big files (28 KB and 82 KB) couldn't use it. The plan still carried the code.

### Row 4 — plugin 0.7.5 (18 Sep): the plan describes the code instead of containing it

- **Problem:** the plan was 1,041 lines, 714 of them code.
- **Fix:** the planner writes short per-file instructions (what the file exports, how it behaves, which existing file to copy the style from, where to edit). A plan checker rejects plans that contain too much code.
- **Runs:** Opus-only $17.96 · Opus + Flash $17.41 (one earlier attempt was invalid: the laptop froze mid-run).
- **Result:** plan down to 419 lines, code in it 714 → 12 lines. Flash's setup fell 16%, but Opus-only fell too, so they ended about even.
- **Learned:** a sleeping or frozen laptop ruins a run, so keep the machine awake.

### Row 5 — planned, not built: shared starting plan

- **Idea:** both setups start from the same plan, to remove planning noise from the comparison. Skipped in favour of Rows 6–7.

### Rows 6–7 — plugin 0.7.7 (21 Sep): automatic task splitting, small edits, Flash reads the code first

- **Problems:** Opus spent turns turning the plan into a task list. Every edit sent a whole file through Flash. The planner spent a long time finding which files to copy.
- **Fixes:**
  - A script turns the plan into the task list at no AI cost (`plan-to-packets.mjs`).
  - Flash sends only the lines that change ("edits" mode), not whole files.
  - Flash scans up to 40 files and gives the planner a map (the "scout").
- **Run:** Opus + Flash $18.77 (two attempts before it were killed by laptop sleep, and one was invalid because an old helper server was still running).
- **Result:** no net gain. Planning got lighter (95 → 56 steps), but Flash needed far more retries (right first try fell from 87% to 57%), hit its output limit 4 times, and 6 tasks needed hand fixes because of a line-number format mismatch.

### Row 8 — plugin 0.7.8 (21 Sep): more reliable edits

- **Fixes:**
  - A retry starts from the original file, not the half-edited one.
  - Whole-project checks run once at the end, instead of after every task.
  - Large edit lists are split into smaller tasks.
  - Flash is told to think less, because its thinking was being billed as output.
- **Runs:** Opus + Flash $17.05 · Opus-only $21.06.
- **Result:** Flash's own waste was gone: Flash cost $0.66 → $0.14, right first try 57% → 76%, hand fixes 6 → 1, output-limit hits 4 → 0.
- **Still wrong:** the comparison was unfair. Opus-only was still paying for steps only Flash needs (the code scan and a strict plan format).

### Row 9 — plugins 0.7.9 and 0.8.0 (21 Sep): a fair Opus-only, batched Flash

- **Fixes:**
  - Opus-only skips the code scan and writes a short plan.
  - Flash receives all its tasks in one call and works on four at a time (`execute_batch`).
- **Runs:** Opus-only $14.86 · Opus + Flash $15.93 · Opus-only again $17.40.
- **Result:** both setups got cheaper and ended about even. Running Opus-only twice with nothing changed gave $14.86 and $17.40, which showed **runs vary by about $2.50** on their own.
- **Still wrong:** the batch tool was missing from the manager's tool list, so a helper relayed it (≈ $1.10 wasted). The task splitter also crashed on a folder name ($0.37 to redo).

### Row 10 — plugin 0.8.1 (23 Sep): setup and planning cleanup

- **Fixes:** batch tool added to the manager's list, shorter Flash plan, and the planner corrects its plan in place instead of rewriting it.
- **Runs:** Opus + Flash $16.12 and $13.90 · Opus-only with 5-minute memory $17.43.
- **Result:** Flash about 9% cheaper on average. The 5-minute memory trial did **not** save money, because long test waits let the memory expire, and reloading it costs more.
- **Still wrong:** the splitter rejected one valid plan layout and silently dropped 9 of 15 tasks in another run.

### Row 11 — plugin 0.8.2 (23 Sep): task splitter improvements

- **Fixes:** the splitter reads more plan layouts, and drops tasks outside the allowed files with a warning. The cost collector learned to price the newest Opus model.
- **Runs:** Opus-only $10.78 · Opus + Flash $12.67.
- **Result:** Opus-only was the cheapest run so far. Flash wrote 19 / 19 tasks in one 47-second batch, but Opus spent extra fixing the plan by hand, so the Flash run was 18% dearer.
- **Found:** the Flash plan was 766 lines against 407 for Opus-only, and line numbers in ordinary sentences were read as edit spots (one would have edited sign-in code).

### Row 12 — plugin 0.8.3 (23 Sep): shorter Flash plan, automatic formatting

- **Fixes:**
  - The Flash plan must be the same size as the Opus-only plan.
  - Line numbers in sentences are ignored.
  - Code is formatted automatically before each check, at no AI cost.
- **Run:** Opus-only $13.17 (about $1.90 of it was unrelated chat).
- **Still wrong:** the splitter didn't recognise the planner's "Edit" layout on 5 files.

### Row 13 — plugin 0.8.4 (23–24 Sep): the splitter reads every edit layout

- **Fix:** the splitter understands the "Edit" sections, so small edits stay small instead of becoming whole-file rewrites.
- **Runs:** Opus + Flash $17.52 · Opus-only $11.60.
- **Result:** the splitter fix worked (0 hand fixes, 0 formatting retries, one batch). But Flash **guessed how the new files import each other** and got it wrong, which took 3 repair rounds. Opus-only was 34% cheaper.

### Row 14 — plugin 0.8.5 (24 Sep): exact imports and an import checker

- **Fixes:**
  - The plan writes out exactly how each file imports the others.
  - A free script checks every import before Opus looks at the result (`check-imports.mjs`).
  - The Flash code scan was dropped, because the planner reads the code itself.
- **Run:** Opus + Flash $11.94 (the first attempt was lost to a network outage).
- **Result:** import errors 3 rounds → 0, and Opus re-read less than half as much. Opus + Flash drew level with Opus-only for the first time.
- **Still wrong:** a "depends on" line that wrapped onto a second line was misread, so 10 of 15 links between tasks were lost and repaired by hand.

### Row 15 — plugin 0.8.6 (24 Sep): line-wrap bug fixed

- **Fix:** the splitter reads a wrapped "depends on" line, and warns when a task has none.
- **Runs:** Opus + Flash $15.32 · Opus-only $14.18.
- **Result:** the fix held and Flash was near perfect (17 / 17 tasks, 7 cents). But the **manager stopped 3 times to wait** for reviewers and tests. Each time it woke up it had to reload its whole memory, about **$4.10** in total. That is more than Flash cost across the entire study. Without it, the Flash run would have cost about $10.80.

### Rows 16–17 — plugins 0.8.7 and 0.8.8 (24 Sep): leaner reviewers, no pauses, cheaper hand-off

This was the turning point.

- **Fixes:**
  - **Leaner reviewers (both setups):** reviewers load all the changes in one step instead of file by file, have a step limit (about 12 for code review and 10 for security), and don't re-run tests the manager already ran. There are still two separate review steps; the pipeline is unchanged.
  - **The manager never stops to wait (both setups):** it keeps checking, within the same step, until the result is ready. This removed the $4.10 reload cost.
  - **Cheaper hand-off to Flash:** the manager gives Flash a file location instead of re-typing the whole task list, and Flash reports back in one line per task (full detail only when something went wrong).
  - **Cost counter works on Opus-only runs** without hand help.
- **Runs:** Opus + Flash $9.79 · Opus-only $13.98.
- **Result:** first clear win for Flash on a same-version pair, **30% cheaper**. The manager never paused, and Flash did all 14 tasks in one 52-second batch. Opus-only typed all its tasks itself and re-read about twice as much.

### Row 18 — plugin 0.8.9 (24–25 Sep): Flash can delete lines, and the splitter accepts everyday words

- **Fixes:**
  - Flash can delete or replace several lines, so small clean-ups stay with Flash instead of Opus.
  - Words like "create" or "modify" in a plan no longer force a redo; they're accepted with a warning.
  - The cost counter finds the run's name on Opus-only runs.
  - The web-test command in the launch instructions was corrected.
- **First pair:** Opus + Flash $9.36 · Opus-only $9.55, a tie. Flash got 19 / 19 tasks right first time, but Google's Flash service was "too busy" 8 times (about 4 minutes lost, almost no cost). Measured on the work itself, Opus-only was about 10% cheaper ($7.37 against $8.15).
- **Second pair:** Opus + Flash **$8.37**, the cheapest run in the study · Opus-only $11.28. Flash wrote all 14 pieces of code in one 50-second batch with no busy errors. Opus-only wrote its 16 pieces one by one, and its page test took 3 tries.
- **Result:** averaged over both 0.8.9 pairs, Opus + Flash $8.87 against Opus-only $10.42 (15% less).

### Row 19 — plugin 0.8.10 (25 Sep): 1-hour memory is the default everywhere

- **Fix:** every shipped policy, including Opus-only, now keeps Opus's memory for 1 hour, so new users get the setting this study measured.
- **Runs:** the small job and large job 1 pairs, plus Large2-A/B (table above).
- **Result:** Flash cheaper on small jobs (≈ 10%) and on large job 1 (≈ 7%). On large job 2, Opus-only was 28% cheaper.
- **Why Large2-A lost:** two problems, both in the planner (an Opus helper), not in Flash:
  1. **Trimming the plan.** The planner wrote a full plan and then spent 34 small edits (≈ $3.86) shortening it to hit a suggested length.
  2. **Line endings.** Some files on this Windows laptop use Windows line endings, which made the formatting check fail. The planner rewrote checks to work around it (≈ $2.07).
- **Study bias found:** resetting files after a run switches them to Linux line endings. The Flash run always went first in each pair, so only Flash runs ever met the Windows endings.

### Row 20 — plugin 0.8.11 (29 Sep): no plan trimming, line-ending-aware checks

- **Fixes:** the planner writes the plan once and never trims it for length. The task splitter adds the right line-ending setting to the formatting check automatically.
- **Runs:** Large2-C Opus + Flash ≈ $12.64 (75 min) · Large2-D Opus-only ≈ $14.63 (74 min).
- **Result:** the fix held (no trimming, no line-ending workarounds). The Flash run cost $4 less than Large2-A, and Flash was **14% cheaper** on this fair pair.
- **Still wrong (next fixes):**
  - Flash wasted 6 attempts on a formatting check that can never pass: the formatter skips docs (`.mdx`) files, yet the plan asked it to check one.
  - Repair steps written by the manager left out the auto-format instruction, so they failed their check.
  - The allowed-files list for a new API page should include the API spec and the assistant-tool docs.

### Row 21 — plugin 0.8.12 (30 Sep): docs files skip the formatter, repair steps auto-format, companion files allowed

- **Fixes:** the three issues from Row 20. Docs files no longer get a formatting check they can never pass. The server adds the auto-format step to repair tasks the manager writes by hand. At the start, the plugin proposes the API spec and the assistant-tool docs as allowed files.
- **Runs:** same large job 2 plus three docs files (28 files). Large2-E Opus + Flash ≈ $10.78 (79 min) · Large2-F Opus-only ≈ $17.09 (72 min).
- **Result:** all three fixes held on both sides: no wasted docs attempts, hand-written repairs passed, and no reviewer complaints about off-limits files. Flash was **37% cheaper**. We re-ran Opus-only (Large2-G) to check: ≈ $16.99, the same as Large2-F, so the $17 is real for this job size, not a fluke. It is not caused by the 0.8.12 fixes (they added no steps to Opus-only); the three extra docs files add about 25 steps, and each step re-reads the whole session so far. The Opus-only run did all 28 tasks itself, one after another, and its helpers re-read about 22 million cached tokens (Flash run: about 9 million).
- **Still wrong (next fixes):**
  - When a file path contains `$` (the web route folder `$workspaceId`), the automatic check puts the path in double quotes, so the shell drops part of it. Flash wasted 3 attempts on an error it could not fix, and a real accessibility error stayed hidden until the manager fixed the command by hand. Fix: quote paths with single quotes, as the import check already does.
  - The plan's "run these checks at the end" section (whole-project type checks) was not carried into the tasks, in either run. The managers ran them by hand anyway, and in the Flash run those checks caught its only real mistakes (two mismatched field names).

## Cost after each stage

| Stage | Opus-only | Opus + Flash | Result |
|---|---|---|---|
| Starting (0.7.3) | $19.16 | $26.02 | Flash 36% dearer |
| Rows 1–3 (0.7.4) | $22.91 | $20.75 | Flash cheaper by $2.16 |
| Row 4 (0.7.5) | $17.96 | $17.41 | about even |
| Rows 6–7 (0.7.7) | — | $18.77 | no change |
| Row 8 (0.7.8) | $21.06 * | $17.05 | Flash cheaper, but unfair |
| Row 9 (0.7.9 / 0.8.0) | $14.86 / $17.40 | $15.93 | about even |
| Row 10 (0.8.1) | $17.43 ** | $16.12 / $13.90 | Flash ≈ 9% cheaper |
| Row 11 (0.8.2) | $10.78 | $12.67 | Opus cheaper by $1.89 |
| Row 12 (0.8.3) | $13.17 | — | Opus-only only |
| Row 13 (0.8.4) | $11.60 | $17.52 | Opus cheaper by $5.92 |
| Row 14 (0.8.5) | — | $11.94 | level with Row 13 Opus-only |
| Row 15 (0.8.6) | $14.18 | $15.32 | Opus cheaper by $1.14 |
| Rows 16–17 (0.8.8) | $13.98 | $9.79 | **Flash 30% cheaper** |
| Row 18 (0.8.9) | $9.55 / $11.28 | $9.36 / $8.37 | **Flash 15% cheaper on average** |
| Row 20 (0.8.11), large job 2 | $15.26 | $13.81 | Flash 14% cheaper (work itself) |
| Row 21 (0.8.12), large job 2 + docs | $17.77 | $11.71 | Flash 37% cheaper (work itself) |

\* Opus-only was still running steps meant only for Flash. \*\* 5-minute memory trial. Rows up to 18 are the medium task; Rows 20–21 are a large job, so its dollars are not comparable with the rows above it.

**Since the start:** Opus + Flash went from $26.02 to $8.37 (−68%). Opus-only went from $19.16 to $9.55 at its best (−50%).

## What each setup is good and bad at

**Opus-only**
- Good: simple (one model, nothing to hand over), needs no second AI provider, and often gets every task right first time.
- Bad: writes every task one after another, so its session grows and it re-reads more. It also swings a lot between identical runs ($9.55 and $11.28 on the same version).

**Opus + Flash**
- Good: Flash is nearly free, and it writes all the code in one parallel batch in under a minute. On the newest versions it was cheaper in all three pairs. Quality was the same: all tests passed and no serious review issues were left.
- Bad: it has more moving parts, so a bug in the hand-over (a missing tool, a misread plan) costs Opus money to repair. It also depends on Google's service being available (it was "too busy" 8 times in one run).

## What we learned

1. **Flash's own price is not what matters.** It is under 10 cents a run. What matters is how much Opus spends around it.
2. **The single biggest saving was the manager not stopping to wait.** Each pause forced a full memory reload, and three pauses cost about $4.10 in one run.
3. **Most fixes helped both setups.** Leaner reviewers and no pauses cut Opus-only's cost as much as Flash's, so the target Flash had to beat kept moving.
4. **Flash pulled ahead only once the hand-over was clean:** exact imports, an import checker, a correct task split, one batch call, and short reports.
5. **Noise is large.** Identical runs differ by up to $2.50, so a single gap smaller than that means little. Only repeated pairs count.
6. **Job size doesn't grow the saving.** Flash saved ≈ 10% on small jobs, ≈ 19% on the medium task, and ≈ 8% on large jobs. On large jobs the Opus planner costs the most, and it is the same Opus on both sides.
7. **Watch for hidden differences between the two runs in a pair.** A file-format difference (line endings) made one large pair look 28% worse for Flash until we found it.
8. **Practical rules for measuring:** keep the laptop awake, don't chat with Claude during a run (it lands in the bill), and give both setups the same memory setting.

## Next

The run phase is finished; more runs would only shift the percentages a little.

| Step | Why |
|---|---|
| Fix the two issues found in Row 21 | Single-quote paths in derived checks (`$` in route folder names), and carry the plan's end-of-run checks into the tasks. |
| Measure a project built from scratch (`/mmo:greenfield`) | A teammate's greenfield runs showed Flash 27–38% cheaper on ~100-file projects; worth confirming on this setup. |
| Build the "shared starting plan" (Row 5) | Takes planning noise out of the comparison, so fewer runs are needed. |

## Where the raw data lives

- **Per-run records** are in the Kaneo repo under `.sdlc/runs/<run-id>/`: the task brief, plan, task list, test results, reviews, `notes.md`, `telemetry.jsonl`, and the code change as `change.patch`.
- **Run IDs** for the small/large phase contain `small-a`…`small-d`, `large-a`, `large-b`, `large2-a`…`large2-g`.
- **Summaries** are in Kaneo's `.sdlc/ledger.md` (one entry per run) and `.sdlc/policy-study.md`.
- **Cost collector:** `plugin/scripts/collect-orchestrator-usage.mjs`. Figures are priced from the Claude Code logs at list prices, not checked against an invoice.
- **Version notes** are in [../methodology.md](../methodology.md), and the technical plan is in [../planning/opus-plus-flash-cost-plan.md](../planning/opus-plus-flash-cost-plan.md).
