---
layout: home
markdownStyles: false
title: genie — UI generation inside your coding agent
description: Generate, preview, and safely apply components from your own UI kit without leaving your coding agent.
---

<div class="genie-home">
  <section class="genie-hero" aria-labelledby="genie-hero-title">
    <div class="genie-hero__content">
      <p class="genie-kicker"><span></span> Open source · MCP-native</p>
      <h1 id="genie-hero-title">Your UI kit,<br><em>ready to answer.</em></h1>
      <p class="genie-deck">Describe the component in your coding agent. Genie generates proposed files from your UI kit, then waits for you to approve the plan before writing and previewing them.</p>
      <div class="genie-actions" aria-label="Get started">
        <a class="genie-button genie-button--primary" href="user/installation">Install genie <span aria-hidden="true">→</span></a>
        <a class="genie-button genie-button--quiet" href="user/workflow">See the workflow</a>
      </div>
    </div>
    <a class="genie-scroll" href="#workflow" aria-label="See how it works"><span>See how it works</span><b aria-hidden="true">↓</b></a>
  </section>
  <section class="genie-workflow" id="workflow" aria-labelledby="genie-workflow-title">
    <div class="genie-workflow__intro">
      <p class="genie-section-label">One prompt, one guarded path</p>
      <h2 id="genie-workflow-title">Stay in your coding agent.<br>Keep control of every write.</h2>
      <p>Genie works where the conversation already happens. Generation stays separate from persistence, so a proposal becomes code only after you approve its plan.</p>
    </div>
    <ol class="genie-steps">
      <li>
        <span>01 / Describe</span>
        <h3>Ask for the component</h3>
        <p><code>conjure</code> and <code>refine</code> generate proposed files from the UI kit you choose.</p>
      </li>
      <li>
        <span>02 / Apply</span>
        <h3>Approve the write</h3>
        <p>Review the bounded plan, then pass its ID to <code>write_files</code>.</p>
      </li>
      <li>
        <span>03 / Preview</span>
        <h3>Inspect the real result</h3>
        <p>Review the persisted component through <code>ui://genie/grid</code> or the local viewer.</p>
      </li>
    </ol>
    <div class="genie-paths">
      <a href="user/">
        <span>Use genie</span>
        <strong>User guide</strong>
        <b aria-hidden="true">↗</b>
      </a>
      <a href="developer/">
        <span>Build genie</span>
        <strong>Developer guide</strong>
        <b aria-hidden="true">↗</b>
      </a>
      <a href="https://github.com/ambitresearch/genie">
        <span>Inspect the source</span>
        <strong>GitHub</strong>
        <b aria-hidden="true">↗</b>
      </a>
    </div>
  </section>
</div>
