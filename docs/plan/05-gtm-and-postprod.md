# genie — Launch & Sharing

> **What this is.** A lean plan for putting genie in front of people and learning
> whether anyone finds it useful. It replaces the original "Go-to-Market + Post-Production"
> doc, which was written as a funded-product GTM (ICP, pricing tiers, revenue model,
> beta program, pirate-metrics funnel). genie is a **solo, AI-assisted, unmonetized
> experiment** — so this is about *sharing*, not *selling*. See `02-brd.md` for the
> full repositioning.
>
> **Owner:** Roshan (solo). **Status:** working draft. **Last revised:** 2026-06-24.

---

## 1. Positioning (one honest line)

> **genie** is an open-source MCP server that brings AI UI-component generation into
> whatever AI coding harness you already use — Claude Code, Cursor, VS Code, Codex,
> Cline, Continue — against your own UI kit, with a live preview, no separate app to open.

Inspired by Anthropic's Claude Design; an independent take on the same idea, built on
public protocol surfaces. **Not** affiliated with Anthropic, not a reproduction of their
hosted canvas. MIT-licensed, self-hostable, model-agnostic via LiteLLM.

The one-liner for a README badge / HN title: *"Harness-agnostic AI component generation, in your editor, against your own UI kit."*

## 2. Who it's for (loosely)

No formal ICP — this is an experiment, not a sales motion. But the people most likely to
care:

- **Solo devs and small teams** who live in an AI coding harness and maintain a component library, and don't want to pay per-seat for a hosted design canvas or be locked to one vendor's chat UI.
- **Self-hosting / sovereignty-minded folks** — homelabbers, regulated shops, anyone who wants the model call to go through *their* gateway (or a local Ollama) and the components to land in *their* git repo.
- **MCP-curious builders** who want to see a non-trivial MCP-Apps server in the wild and maybe fork it.

If none of these people find it useful, that's a real and useful answer (see §6).

## 3. Where to share it

One honest launch, a few durable listings, then let it find its own level. No paid spend, no growth hacking.

| Channel | What | When |
|---|---|---|
| **Launch post** | One honest write-up: what genie is, *why I built it* (the experiment framing), what I learned about MCP-Apps and the bundled-skill protocol, and a live demo GIF. Personal blog + cross-post. | Launch day |
| **Hacker News** | `Show HN: genie — AI UI-component generation inside your coding agent (MCP, MIT)`. Honest title, no overclaiming, present and answer in the thread. | Launch day |
| **Reddit** | r/LocalLLaMA (the self-host + local-model angle plays well there), maybe r/programming. | Launch week |
| **awesome-mcp / mcp.so** | PR genie into the registries. Durable discovery — this is where MCP-curious people actually browse. | Launch week |
| **Lobsters / dev.to** | If the HN post lands, cross-post the write-up. | Follow-up |
| **The MCP community** | Wherever the protocol's builders hang out (Discord/GitHub Discussions). Share as "here's a thing I built on the spec," not as a product pitch. | Ongoing |

What I'm explicitly **not** doing: cold outreach, conference-talk circuit, influencer seeding, a hosted free tier as a funnel, paid ads, or a launch sequence with a countdown. It's one post and some listings.

## 4. Launch checklist (the useful bones)

Before the launch post goes live:

- [ ] README: elevator line, 60-second quickstart, the honest "what this is / isn't" framing, badge row (CI · npm · license), demo GIF.
- [ ] All 7 Tier-0 harnesses have a working config snippet + a green smoke test (BO-5).
- [ ] `npx genie init` → first `generate_component` works on a fresh machine (the time-to-first-component path, K-10).
- [ ] At least one exemplar UI kit so the demo isn't empty.
- [ ] `npm` + Docker + `.mcpb` artifacts published and install-verified (BO-7).
- [ ] LICENSE, SECURITY.md, CONTRIBUTING, CODE_OF_CONDUCT in place.
- [ ] Trademark posture sanity-checked (BRD §12.5): generic name, no Anthropic marks/logos, "inspired by" not "clone of."
- [ ] A social/status handle that is **not** `@genie_clone` or anything implying a reproduction.
- [ ] No P0 security finding open (GL-8).
- [ ] The launch post drafted and honest — leads with *why*, not hype.

## 5. After launch (light cadence)

- **Respond to everything** in the first 48h — HN comments, issues, PRs. That's where the real signal is.
- **Triage, don't commit.** It's fine for an issue to sit. There's no SLA (`06-operations-runbook.md` §11.1).
- **Ship fixes for anything that blocks a real install** — a broken quickstart on launch day is the one thing worth dropping everything for.
- **Write one honest follow-up** a few weeks in: "what happened when I shared genie" — the numbers, the surprises, what people actually used it for. That post is often more valuable than the launch itself.

## 6. What "success" means (signal, not seats)

This is the whole point, so it's worth stating plainly. genie is a probe into one question: **are MCP-Apps — rich UI rendered inside an AI coding harness — actually useful?** The launch is how we get signal on that.

Success is **not** a star count, a revenue number, or a seat-displacement rate. Success is *learning the answer*. Concretely, any of these would be a strong positive signal:

- I genuinely use genie in my own work after the novelty wears off (the n=1 case study, BO-3).
- A handful of strangers install it and come back with real feedback, forks, or "I used this to…" (BO-4/BO-6).
- The MCP-Apps rendering path works well enough across harnesses that the "harness-agnostic" promise feels real, not theoretical.

And the honest negative signals, which are equally valuable:

- Nobody (including me) reaches for it after launch week → MCP-Apps may not be a category yet, or genie isn't the right shape. Good to know cheaply.
- The cross-harness rendering is too fragile to be pleasant → the spec isn't ready, park it and revisit.

This maps to the BRD's **§15.3 reality gate** (GR-1/2/3): a few months post-launch, honestly answer "did it prove useful, to me or anyone?" and "is this still the most interesting use of spare time?" — then keep going, park it as *answered*, or roll the learning into the next idea. A solo experiment that produces a clear "no" is still a success if it was cheap and you learned something. genie is cheap (`02-brd.md` §13). The bar is just: learn the answer.

## 7. Honest risks (the launch-relevant ones)

| Risk | Reality | Posture |
|---|---|---|
| **Nobody cares** | Most launches sink without trace. | Fine. The cost was spare time, the deliverable is owned, the learning is real. Park it (GR-3). |
| **"It's just a Claude Design clone"** in the comments | The single most likely critique. | Pre-empt it in the launch post: lead with the *independent / inspired-by / self-host / model-agnostic* framing. It's genuinely a different thing (open, harness-agnostic, your gateway, your repo). Don't be defensive — agree it's inspired, point at what's actually different. |
| **Anthropic notices** | Low likelihood, but possible. | Calm, not panicked. Generic name, no marks, clean-room engineering, "inspired by" everywhere. Respond within a few days if contacted; optional friendly counsel if it escalates (BRD §12.5, R-01). Frame genie as a complement, not a competitor. |
| **A bug embarrasses on launch day** | A broken quickstart in front of HN. | Test the fresh-install path obsessively pre-launch (checklist §4). Have the fix-and-redeploy loop ready (`AGENTS.md`). |
| **Overclaiming in the post** | The fastest way to lose credibility. | Honest write-up only. "Here's an experiment and what I learned" ages far better than "the open Claude Design." The modest framing *is* the strategy. |

---

*Superseded the original GTM doc (ICP / pricing / revenue model / beta program / pirate
metrics) on 2026-06-24 as part of the solo-experiment repositioning. If genie ever
surfaces something worth monetizing, a real GTM is a separate, later decision — see
BRD §13.3.*
