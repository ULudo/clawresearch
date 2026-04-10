# Autonomous Research Agent Literature Synthesis and Developer Concept

## Purpose

This document synthesizes the provided literature on autonomous research agents and turns it into a practical development concept for a PhD-level research agent.

The goal is not just to summarize papers. The goal is to extract what the literature already tells us about:

- what works
- what reliably fails
- what a serious autonomous research system must be able to do
- how such a system should be engineered if we want publishable, defensible research outputs rather than impressive demos

This document is written as a design input for `/Users/uludo/Documents/New project/clawresearch`.

## Sources Reviewed

The synthesis below is based on the following sources provided in this task:

- `A Vision for Auto Research with LLM Agents`
- `AI-Researcher: Autonomous Scientific Innovation`
- `InternAgent: When Agent Becomes the Scientist -- Building Closed-Loop System from Hypothesis to Verification`
- `Towards Scientific Intelligence: A Survey of LLM-based Scientific Agents`
- `The AI Scientist-v2: Workshop-Level Automated Scientific Discovery via Agentic Tree Search`
- `Agent Laboratory: Using LLM Agents as Research Assistants`
- `PaperOrchestra: A Multi-Agent Framework for Automated AI Research Paper Writing`
- `Memory Intelligence Agent`
- `andrej_karpathy.txt`
- `Dolphin: Moving Towards Closed-loop Auto-research through Thinking, Practice, and Feedback`
- `CycleResearcher: Improving Automated Research via Automated Review`
- `SR-Scientist: Scientific Equation Discovery With Agentic AI`
- `DeepScientist: Advancing Frontier-Pushing Scientific Findings Progressively`

## Executive Summary

The literature is already clear on one point: a serious autonomous research agent is not just a chatbot with tool calls.

The successful systems are converging on a common pattern:

- explicit planning
- persistent memory
- structured actions over tools, code, search, and experiments
- verification before accepting conclusions
- iterative closed loops rather than single-pass generation

At the same time, the literature is equally clear on the current failure modes:

- weak long-horizon memory
- shallow literature synthesis
- poor methodological rigor
- hallucinated or unsupported claims
- unreliable self-evaluation
- brittle experiment execution and debugging
- overclaiming publication readiness

The strongest conclusion across the papers is this:

> If we want a research agent that produces publication-worthy work, the core problem is not “make the model smarter.” The core problem is to build a closed-loop scientific operating system around the model.

That operating system must treat research as a managed process with:

- explicit hypotheses
- claims and evidence
- experiments and reproducibility metadata
- review and verification
- memory consolidation
- approval gates for risky or expensive actions

For `clawresearch`, the right target is not “an AI scientist that solves any problem end-to-end with no supervision.” The right target is:

> a bounded-autonomy, persistent, empirically grounded research operator for computational and coding-heavy research, capable of planning, executing, debugging, validating, and writing at a level that meaningfully supports or approximates PhD-level research practice.

## Paper-by-Paper Synthesis

### 1. A Vision for Auto Research with LLM Agents

### Core contribution

This paper is primarily a vision paper. Its main value is not empirical proof, but a full-lifecycle framing of automated research as a chain spanning:

- literature
- idea
- method
- experiment
- paper
- evaluation
- rebuttal
- promotion

### Important findings

- Research should be treated as a complete lifecycle, not just idea generation or paper drafting.
- The paper introduces the notion of a `meta-method`: a higher-level intelligence layer that reasons about which research methodology to use, not just which tool to call next.
- It distinguishes cumulative research from disruptive research, which is useful because a research agent should not treat all innovation as the same kind of task.
- It emphasizes knowledge creation as a multi-stage process:
  - multi-source integration
  - contextual synthesis
  - hypothesis generation
  - validation
  - human-AI collaboration

### Implementation implications

- A research agent should have an explicit methodology-selection layer.
- The system should support different research modes:
  - literature synthesis
  - replication
  - incremental improvement
  - disruptive exploration
- Rebuttal, evaluation, and communication are part of the full system, even if they come after the core research loop.

### Limits

- The paper is conceptually useful, but light on rigorous runtime details.
- It should inform architecture and product scope, but not be treated as proof that the full stack already works.

### 2. AI-Researcher: Autonomous Scientific Innovation

### Core contribution

AI-Researcher attempts a fully autonomous pipeline from literature review to hypothesis generation, method implementation, experimentation, and manuscript production. It also introduces `Scientist-Bench` to evaluate autonomous scientific workflows.

### Important findings

- The system demonstrates that multi-agent pipelines can cover the full research loop with minimal human intervention.
- It uses a benchmark design that tries hard to reduce leakage and memorization:
  - influential reference extraction
  - research instruction generation
  - anonymization of model and paper names
- The benchmark separates:
  - guided innovation
  - open-ended exploration
- The paper argues that AI systems can reach near-human quality in some benchmarked workflows.

### Important failure analysis from the paper

The paper is especially useful because it explicitly names three major weaknesses:

- multi-turn implementation fidelity degrades over long interactions
- memory management is too primitive when only the context window is used
- evaluation is still weak, especially around idea quality and scientific merit

The paper calls out:

- missing dedicated external memory systems
- loss of fine-grained detail as workflows are repeatedly summarized
- inadequate evaluation of novelty, feasibility, and idea quality
- LLM reviewers overvaluing presentation over substantive contribution

### Implementation implications

- Long-horizon research cannot rely on context-window memory alone.
- External structured memory is mandatory.
- Evaluation must be richer than “did the code run?” or “did the paper look polished?”
- Anti-leakage and anti-memorization benchmark design matter if we want to honestly evaluate an autonomous research system.

### Limits

- AI-Researcher is ambitious, but still exposes the gap between “end-to-end pipeline exists” and “scientific rigor is consistently strong.”
- It is a strong reference for benchmark construction and full-pipeline ambition, but not yet a proof that autonomy alone is sufficient.

### 3. InternAgent: Building Closed-Loop System from Hypothesis to Verification

### Core contribution

InternAgent is one of the most relevant papers for `clawresearch` because it explicitly frames autonomous research as a closed loop from hypothesis to verification.

### Important findings

- The architecture separates:
  - idea generation
  - methodology construction
  - experiment planning and execution
  - exception-guided debugging
  - assessment and refinement
- It uses a coordinated multi-agent structure with specialized roles such as:
  - Survey Agent
  - Code Review Agent
  - Idea Innovation Agent
  - Assessment Agent
- It introduces a `Method Development Agent`, which is a very important design idea:
  - methodology is not the same as idea
  - methodology needs to be constructed, critiqued, and refined
- The experimentation loop is adaptive rather than linear:
  - experiments are planned
  - failures trigger debugging
  - debugging can revise implementation and method

### Comparative finding

The paper explicitly claims better performance than AI-Researcher on some tasks because:

- it searches more broadly for ideas
- it plans experiments more completely
- it adapts via debugging and evolution
- it makes better use of codebase context

### Implementation implications

- The research loop must be closed:
  - hypothesis
  - method
  - implementation
  - experiment
  - debugging
  - verification
- Methodology design should be a first-class object, not an afterthought.
- Repo-aware implementation and exception-guided debugging are essential.
- The agent must use environmental feedback, agent feedback, and human feedback as learning signals.

### Limits

- It is still an agentic research framework paper rather than evidence that top-tier publication quality is routine.
- It points to the right closed-loop structure, which is highly relevant to our implementation direction.

### 4. Towards Scientific Intelligence: A Survey of LLM-based Scientific Agents

### Core contribution

This survey provides the best high-level taxonomy in the set. It frames scientific agents as systems built from four architectural mechanisms:

- Planner
- Memory
- Action Space
- Verifier

This is the cleanest general design vocabulary for our own system.

### Important findings

The survey’s planner taxonomy is especially useful. It distinguishes:

- prompt-native planners
  - instructional/schema-driven
  - context-augmented
  - deliberative/reflective
  - search-based
  - role-interactive/multi-agent
  - programmatic
- learned planners
  - supervised/domain-trained
  - RL or preference-optimized

For memory, it distinguishes:

- historical context
- external knowledge bases
- intrinsic or parametric memory

For action spaces, it distinguishes:

- tool use / environmental control
- search and retrieval
- code generation and execution
- reasoning actions

For verification, it distinguishes:

- self-correction
- multi-agent critique
- human-in-the-loop
- tool-based validation

### Important design takeaways

- Scientific agents are not defined by a single model role; they are defined by the interaction between these four mechanisms.
- Verification is not optional. It is an equal architectural pillar.
- Memory should not just store facts; it must support long-horizon refinement and decision-making.
- Action space design determines what domains the agent can meaningfully operate in.

### Ethical and governance findings

The survey also emphasizes:

- provenance tracking
- reproducibility
- fairness and data bias mitigation
- hallucination resistance
- security against prompt injection, poisoned data, and malicious collaborators
- human accountability for final outputs

### Implementation implications

If `clawresearch` is serious, it should be intentionally designed around these four pillars:

- planner
- memory
- action space
- verifier

and not around a single assistant loop.

### 5. The AI Scientist-v2

### Core contribution

AI Scientist-v2 pushes beyond fixed experiment templates and uses agentic tree search, experiment management, and VLM-enhanced review to increase autonomy in scientific discovery.

### Important findings

- It claims the first fully AI-generated workshop-accepted paper.
- It improves over AI Scientist-v1 by:
  - removing dependence on human-authored code templates
  - introducing agentic tree search
  - using an experiment progress manager
  - using VLM feedback for figures and review
  - allowing parallel experiment execution
- It shifts from a purely linear experimentation flow toward structured search over experimental trajectories.

### Important caution

The surrounding evidence and reviews are at least as important as the headline result:

- some AI-generated papers were still rejected
- motivations were sometimes weak
- evidence was sometimes incomplete
- captions and experimental framing could still be poor
- “accepted” did not mean “scientifically mature in all respects”

### Implementation implications

- Search over experimental options is better than linear single-path iteration.
- An explicit experiment manager is a high-value architectural component.
- Review and figure quality matter and benefit from dedicated feedback loops.
- Publication claims must be tempered by stronger rigor checks than “the paper looks plausible.”

### 6. Agent Laboratory

### Core contribution

Agent Laboratory is especially valuable because it measures autonomous research systems with human judgment rather than only self-contained internal metrics.

### Important findings

- The system supports literature review, experimentation, report writing, and optional human feedback.
- Stronger reasoning models performed better.
- Human involvement significantly improved research quality.
- Cost could be much lower than previous approaches.

### Most important empirical finding

Autonomous papers were still below strong conference acceptance thresholds in human evaluation.

The paper reports two very important gaps:

- automated reviewers overestimated paper quality
- human evaluators judged the work as materially weaker

### Major failure modes documented

- literature review loops can get stuck
- token limits can break retrieval-heavy stages
- experiments can fail and the agent may not recover well
- repo-level code handling remains weak
- subprocess and command execution safety is a real concern
- hallucinated experimental results can appear

### Implementation implications

- Human evaluation remains necessary for serious quality claims.
- LLM-only self-evaluation is not enough.
- Repo-level execution needs much stronger engineering than paper-writing pipelines alone.
- Safety and runtime controls are product requirements, not polish.

### 7. PaperOrchestra

### Core contribution

PaperOrchestra is not a full research loop system. It is a dedicated manuscript-generation system that turns unconstrained pre-writing materials into submission-ready papers, with strong emphasis on literature review quality and visual generation.

### Important findings

- Writing is a separable subsystem.
- Existing end-to-end research agents often have weak writing modules because writing is too tightly coupled to their internal experimental loop.
- Targeted literature synthesis, citation verification, and conceptual figure generation substantially improve manuscript quality.
- Human side-by-side evaluation shows clear gains over autonomous baselines in literature review quality and overall manuscript quality.

### Important limitations

- It depends on external figure-generation components.
- Human accountability remains necessary.
- Benchmark contamination remains a real concern.
- Its authors explicitly frame it as an assistive tool, not an autonomous author.

### Implementation implications

- Manuscript generation should be decoupled from the core experiment runtime.
- Related work generation needs its own strong retrieval and verification pipeline.
- Citation validation must be programmatic, not “best effort.”
- Writing quality should be evaluated separately from research quality.

### 8. Memory Intelligence Agent

### Core contribution

MIA is not a research-agent paper directly. Its main contribution is a memory architecture for deep research agents.

### Important findings

- Long-context memory alone performs poorly for deep research.
- The most effective use of memory is not to dump memory into the executor, but to use memory to guide planning.
- The architecture separates:
  - Memory Manager
  - Planner
  - Executor
- It combines:
  - non-parametric memory
  - parametric memory
  - reflection
  - continual test-time learning

### Important empirical finding

The paper reports that “only memory” can hurt, while “memory for planner” helps. That is one of the most actionable architectural findings across all sources.

### Implementation implications

- Memory should inform planning, not just be added as raw context.
- Experience should be compressed and consolidated.
- Positive and negative trajectories should both be retained.
- The system should learn from failures, not only from successful runs.

### Limits

- MIA is stronger on reasoning-memory mechanics than on scientific workflow specifics.
- It is most useful to us as a subsystem design reference.

### 9. Andrej Karpathy Note on LLM Knowledge Bases

### Core contribution

This note is not a formal paper, but it is practically important because it describes an extremely workable knowledge-management pattern for research with LLMs.

### Important findings

- Source material is collected into a raw directory.
- An LLM incrementally compiles this into a structured markdown wiki.
- The wiki becomes the working research memory:
  - summaries
  - concepts
  - backlinks
  - derived visuals
  - outputs filed back into the knowledge base
- LLM outputs are more useful as persistent artifacts than transient terminal text.
- Health checks over the knowledge base help identify inconsistencies, missing data, and new research questions.

### Implementation implications

- Markdown-first knowledge accumulation is a strong fit for `clawresearch`.
- Persistent artifacts should be first-class.
- The agent should maintain a living research knowledge base, not only ephemeral task state.
- Research outputs should accumulate into reusable memory.

### 10. Dolphin: Moving Towards Closed-loop Auto-research through Thinking, Practice, and Feedback

### Core contribution

Dolphin is one of the clearest papers in the set on what a practical closed-loop research runtime should look like when moving beyond idea generation alone.

### Important findings

- The framework is explicitly organized around three stages:
  - idea generation
  - experimental verification
  - results feedback
- It introduces `task-attribute-guided paper ranking`, where retrieved papers are filtered not only by topic similarity but also by whether their task attributes match the target problem.
- It filters ideas for:
  - redundancy
  - independence
  - novelty
- It uses an `exception-traceback-guided` debugging process that combines traceback information with local code structure to guide repair.
- It feeds experimental outcomes back into future idea generation:
  - ideas that fail or stagnate become negatives
  - ideas that help performance become seeds for future ideation

### Why it matters

This paper provides unusually concrete heuristics for two weak points in many research-agent systems:

- retrieval quality
- code debugging quality

### Implementation implications

- Literature retrieval should be task-aware, not just keyword-driven.
- The system should explicitly store and reuse:
  - ineffective ideas
  - performance-improving ideas
- Debugging should be traceback-aware and localized to the relevant code region rather than generic whole-repo rewriting.
- Feedback from experiments should shape future ideation directly, not just be written into a log.

### Limits

- Dolphin still relies heavily on titles and abstracts during paper ranking, which can miss technical nuance.
- The paper also admits that project-level code understanding remains a weak point.
- It is a strong runtime reference, but not a complete answer to long-horizon, real-repo research autonomy.

### 11. CycleResearcher: Improving Automated Research via Automated Review

### Core contribution

CycleResearcher is best understood as a research-and-review training framework, not as evidence that we already have a trustworthy empirical science runtime.

### Important findings

- The framework mirrors a `Research -> Review -> Refinement` cycle.
- It separates:
  - `CycleResearcher` as the policy model
  - `CycleReviewer` as the reward model
- It introduces large datasets for:
  - peer review dynamics
  - research paper generation structure
- It shows that review-style feedback can be used as a training signal for iterative improvement.

### Most important caution

The paper includes a crucial limitation for our purposes:

- its experimental results inside generated papers are fabricated in the training environment rather than produced by real executed experiments

That means the paper is useful as evidence for:

- automated review loops
- preference training
- critique-driven improvement

but it is not strong evidence for:

- trustworthy autonomous empirical research execution

### Additional warnings from the paper

- reward hacking is explicitly acknowledged as a risk
- the system is domain-specific to machine learning
- novelty assessment degrades because the reviewer model is offline and knowledge-limited

### Implementation implications

- Automated review can be a useful low-cost surrogate signal.
- Review models should never be treated as ground truth for scientific merit.
- Reward hacking needs active defenses if review scores are used inside optimization loops.
- Review/refinement should be decoupled from claims about real experimental validity.

### 12. SR-Scientist: Scientific Equation Discovery With Agentic AI

### Core contribution

SR-Scientist shows what happens when the autonomous research problem is tightly scoped, tool-grounded, and quantitatively verifiable.

### Important findings

- The system treats symbolic regression as a long-horizon agentic optimization problem.
- The agent uses tools for:
  - data analysis
  - equation implementation
  - equation evaluation
- It introduces an `experience buffer` to store explored equations and feed strong candidates back into later iterations.
- It explicitly aims for minimal human-defined pipelines and lets the agent determine its own workflow within the tool environment.
- RL improves performance further.

### Why it matters

This paper is a strong reminder that autonomous scientific systems work best when:

- the task is sharply defined
- feedback is frequent
- verification is objective
- the action space is tightly coupled to the domain

### Implementation implications

- `clawresearch` should strongly favor domains with measurable and inspectable feedback loops.
- Experience buffers are useful not only for successful runs, but for avoiding repeated bad search trajectories.
- Domain-specific tool wrappers can dramatically reduce pointless code-writing churn.
- Flexible workflows matter, but they need bounded, inspectable tool surfaces.

### Limits

- The domain is narrow and unusually clean.
- Success here does not automatically transfer to open-ended, messy real-world empirical research.
- Still, it is one of the strongest positive examples of autonomous scientific improvement under strong grounding.

### 13. DeepScientist: Advancing Frontier-Pushing Scientific Findings Progressively

### Core contribution

DeepScientist adds something genuinely important to the literature: a progressive, multi-fidelity view of scientific exploration.

### Important findings

- The system explicitly models discovery as a goal-driven optimization problem over candidate methods.
- It uses a `Findings Memory`, which stores structured records at different maturity stages.
- The research loop is hierarchical and progressive:
  - `Strategize & Hypothesize`
  - `Implement & Verify`
  - `Analyze & Report`
- Early-stage candidates are screened by a low-cost surrogate reviewer.
- Expensive implementation and experiment execution are allocated only to promising hypotheses.
- Successful findings are promoted into deeper analysis and manuscript production.

### Most important empirical signals

- Over 5,000 ideas were generated.
- Only roughly 1,100 were implemented.
- Only 21 led to genuine progress.

This is one of the most valuable findings in the entire literature set:

> autonomous research appears to be a high-throughput, low-yield process, so selection and filtering are central, not peripheral

### Important human evaluation finding

Human experts praised the ideation quality, but still found empirical soundness weaker than it should be.

That is a highly relevant warning for us:

- ideation may scale earlier than trustworthy validation

### Implementation implications

- `clawresearch` should adopt a progressive, multi-fidelity exploration model.
- Not every idea should become an experiment.
- The system should store findings at different stages of maturity.
- A cheap surrogate evaluator is useful as a triage tool, but not as the final arbiter.
- Successful ideas should trigger deeper follow-up analyses, not just “baseline passed, write paper.”

### Limits

- The paper makes strong frontier claims, but it also documents low success rates and remaining weaknesses in empirical validation.
- Its most transferable contribution is the architecture of staged exploration and Findings Memory, not the headline claim alone.

## Cross-Paper Findings

Across the papers, several conclusions repeat with surprising consistency.

### 1. Closed-loop research beats single-pass generation

The best systems do not “answer the research question” in one shot. They:

- propose
- critique
- implement
- run
- observe
- debug
- replan
- verify

This is the single most important architectural lesson.

### 2. Planning must be explicit

A serious research agent needs explicit decomposition of:

- research question
- hypotheses
- methods
- experimental decisions
- next actions

Good systems do not leave this implicit inside a chat transcript.

### 3. Multi-fidelity exploration is a core capability

The newer papers make something much clearer than the first wave did:

- autonomous research is high-throughput
- expensive validation is scarce
- most ideas will fail

That means the system needs staged exploration:

- cheap hypothesis generation
- cheap surrogate evaluation
- selective implementation
- selective deep analysis

This is not an optimization detail. It is part of the scientific operating model.

### 4. Memory is not just context stuffing

The literature strongly rejects the idea that long-horizon research can be solved by “just giving the model more context.”

The more robust pattern is:

- structured external memory
- compressed trajectory memory
- memory retrieval by relevance and quality
- planning conditioned on memory
- consolidation of successful and failed strategies

### 5. Verification is a first-class architectural pillar

Every strong system includes some combination of:

- reflective checks
- critic agents
- tool-based validation
- human review
- simulation or code execution

Without verification, the agent may produce polished nonsense.

### 6. Experiment management is a system problem, not a prompt problem

Empirical research systems need runtime infrastructure:

- job execution
- retries
- monitoring
- exception handling
- artifact capture
- reproducibility metadata

This is one of the biggest gaps between impressive demos and trustworthy research systems.

### 7. Automated review is useful, but dangerous as ground truth

The new literature sharpens this point:

- automated review can help with triage, critique, and iterative refinement
- but it is highly vulnerable to reward hacking, stale knowledge, and overestimation of quality

So review models are useful as:

- surrogate evaluators
- critique generators
- drafting aids

but not as final evidence that a paper is scientifically sound.

### 8. Writing is important, but it should be decoupled

Writing quality matters a lot, but the literature suggests that:

- manuscript generation is its own subsystem
- literature review quality is a specialized problem
- citation correctness requires dedicated retrieval and validation
- good papers require more than just turning logs into prose

### 9. LLM self-evaluation is not enough

This is one of the clearest warnings in the set.

Automated reviewers often overestimate quality.
Human review still catches:

- weak motivation
- unsupported claims
- shallow experiments
- poor novelty positioning
- misleading framing

### 10. Human involvement still matters, but it should be structured

The literature does not support “fully unsupervised, always right AI scientist.”
What it does support is bounded autonomy with humans intervening at high-leverage moments:

- research direction changes
- expensive experiments
- publication decisions
- safety-critical or high-impact claims

### 11. Provenance and reproducibility are non-negotiable

If a system cannot say:

- what it ran
- why it ran it
- under which configuration
- using which code version
- producing which artifact

then it is not a serious research system.

### 12. Narrow, well-grounded domains are the strongest proving ground

Papers like SR-Scientist show that agentic scientific progress is strongest when:

- the environment is measurable
- feedback is objective
- the tool surface is constrained
- success and failure can be distinguished quickly

This does not mean general autonomous research is impossible.
It means the best path to a strong system is through domains with tight feedback loops first.

## What a PhD-Level Autonomous Research Agent Must Be Able To Do

Here “PhD-level” should be interpreted carefully.

It should not mean:

- magically solving any open problem in any domain
- replacing deep domain expertise in pure theory
- publishing at top-tier level without any oversight

It should mean:

- operating with the discipline, decomposition, evidence tracking, and iterative rigor expected from a strong PhD researcher in empirical computational work

The agent should therefore be able to:

### 1. Frame a research problem precisely

- turn broad prompts into tractable research questions
- identify whether the task is:
  - replication
  - benchmarking
  - ablation
  - method improvement
  - new hypothesis generation
- narrow over-broad questions into decisive questions

### 2. Build and maintain a literature-grounded understanding

- retrieve relevant work
- synthesize prior work by theme, not as a list
- identify the actual research gap
- detect missing baselines and confounders
- maintain a persistent knowledge base

### 3. Construct methodologies, not just ideas

- translate an idea into a concrete method
- define assumptions
- specify evaluation design
- specify baselines, controls, and ablations
- identify decisive experiments

### 4. Implement in real codebases

- inspect and understand existing code
- identify entry points and experimental surfaces
- modify code safely
- debug failures
- avoid breaking unrelated components

### 5. Run and manage experiments autonomously

- schedule experiments
- observe logs and failures
- recover from common runtime issues
- detect invalid runs
- stop unproductive loops
- manage compute resources and budgets
- decide which ideas deserve expensive execution and which should be filtered early

### 6. Track claims and evidence explicitly

- store hypotheses
- connect claims to evidence
- weaken claims when evidence is mixed or negative
- avoid promotion of unsupported conclusions

### 7. Verify before concluding

- run tool-based checks
- compare against baselines
- perform consistency checks
- request review or approval when stakes are high

### 8. Produce useful research artifacts

- research notes
- literature maps
- experiment summaries
- evidence logs
- manuscript drafts
- rebuttal-ready explanations

### 9. Learn from prior runs

- retain process memory
- remember failed approaches
- reuse successful patterns
- refine planning policies over time
- maintain findings at different maturity levels rather than flattening everything into one note

### 10. Respect scientific and operational constraints

- provenance
- reproducibility
- safety
- auditability
- resource limits
- human accountability

## What Such a System Should Enable

If built well, such a system should enable:

- much faster literature grounding for new problems
- autonomous replication and extension of recent papers
- stronger baseline discovery
- more systematic ablation and debugging
- deeper experiment throughput on one codebase over long horizons
- persistent evidence accumulation across weeks, not single chat sessions
- manuscript drafting that is grounded in real experimental state
- more publishable negative results because failed hypotheses are tracked rigorously
- better collaboration between humans and agents because the state is explicit

## Experience Report from the First ClawResearch Iteration

Before turning the literature into a concrete concept, it is important to record what we learned from the first ClawResearch implementation attempt.

### What worked

The first iteration was not wasted work. It surfaced several ideas that still look correct:

- long-running research work needs persistence and resume support
- detached job execution matters
- experiment outputs, logs, and artifacts need structured handling
- claims, evidence, and findings are better explicit than implicit
- local and open model backends are viable for this type of system
- a research agent needs a readable live trace, not only a hidden database

### What created accidental complexity

Several design decisions turned out to be more about our debugging process than about the real product:

- the `workspace_root` versus `codebase_root` split leaked implementation detail into the user model
- approval gates and policy controls were introduced too early
- the API layer and web shell pulled focus away from the actual research loop
- the entity model became too broad too early
- the architecture drifted toward a research control plane before the core autonomous process was solid

### What we learned about user experience

The primary user experience for the next attempt should be much simpler:

- start with `clawresearch`
- discuss the research direction in a console chat
- start the autonomous loop
- watch a readable step-by-step live trace
- interrupt only when needed

This is much closer to the interaction style that people already understand from agentic coding tools.

### What we learned about safety and governance

Safety still matters, but it should not dominate the earliest development phase.

For the reset attempt:

- observability should come before governance
- failure modes should be discovered in practice
- hardening layers should be added after the core runtime is reliable

This means the initial system should favor:

- transparent logs
- reproducibility
- clear traces
- minimal but explicit state

before:

- approval gates
- strict policy engines
- elaborate safety choreography

### What we learned about the codebase itself

The current codebase contains useful experience, but it is not a clean foundation for the next system.

The most likely correct move is:

- archive the first implementation as an experience source
- reuse only narrow ideas and small utilities if they fit naturally
- rewrite the actual runtime core around the new, simpler concept

In other words, this is closer to a concept reset than to a refactor.

## Revised Concept for ClawResearch

Based on both the literature and our first implementation experience, the concept should now be reset around a smaller and more direct core.

### Core thesis

ClawResearch should not start as a research platform or governance-heavy orchestrator.

It should start as:

> a console-first autonomous research runtime that takes a research direction, works inside the current project directory, runs long-horizon research loops, and accumulates findings, logs, and artifacts until it either reaches a meaningful result or gets stuck in a way a human can clearly inspect.

### Design stance

The new design should be:

- bottom-up, not top-down
- runtime-first, not platform-first
- console-first, not web-first
- research-loop-first, not control-plane-first
- observable-first, not governance-first

## Non-Negotiable Design Requirements for the Reset

These are the design requirements for the next attempt, not the full mature end-state.

### 1. Single-directory project model

The current directory should be the project.

That means:

- no `workspace_root`
- no `codebase_root`
- no extra project indirection in the primary user path

If the system needs more advanced layouts later, they can be added later.

### 2. Single-command console entry

The primary interface should be:

- `clawresearch`

It should:

- start a research chat
- clarify the research direction
- switch into autonomous mode with `/go`
- show a readable live trace

### 3. Persistent run and job state

The system must survive interruption.

At minimum it needs persistent state for:

- project/session
- current research direction
- runs
- jobs
- findings
- artifacts

### 4. Detached long-running job execution

The system must be able to:

- launch jobs
- observe them over time
- recover status after restart
- continue the research loop after job completion or failure

### 5. Minimal but trustworthy research trace

We do not need a maximal event-sourcing architecture at the start.
We do need a trustworthy trace of:

- what the agent decided
- which command it ran
- what came back
- what finding it produced next

This trace should be easy to read and persisted.

### 6. Findings memory with maturity states

The runtime should not flatten everything into tasks and notes.

It should explicitly distinguish at least:

- idea
- selected direction
- implemented finding
- validated finding
- failed finding

This is the simplest useful version of the stronger `Findings Memory` idea from the literature.

### 7. Closed-loop research runtime

The system must support a real loop:

- discuss
- propose
- implement
- run
- inspect
- revise
- repeat

### 8. Reproducibility metadata for every meaningful run

For each meaningful execution, the system should capture:

- code revision or dirty state
- command
- relevant config
- dataset reference if applicable
- output artifact paths
- timestamps

### 9. Tool and model openness

The runtime should stay backend-agnostic.

It should be able to use:

- local open-source models
- hosted models
- coding-agent wrappers

without baking one provider into the architecture.

### 10. Hardening is deferred, not ignored

The reset should explicitly defer, not deny, later additions such as:

- approval gates
- policy engines
- stronger sandboxing
- publication controls
- web platform layers

These belong to later hardening phases once the autonomous loop itself is reliable.

## Recommended Reset Architecture

The new ClawResearch architecture should be much smaller than the current one.

### 1. Console Layer

Responsibilities:

- initial research chat
- `/go` to start autonomy
- live trace during autonomous execution
- simple commands such as:
  - `/status`
  - `/pause`
  - `/resume`
  - `/quit`

This is the primary product surface.

### 2. Runtime Core

Responsibilities:

- current project/session state
- current research direction
- orchestration of the main loop
- persistence across restarts

This should stay small and debuggable.

### 3. Job Layer

Responsibilities:

- start long-running tasks
- monitor status
- store logs and outputs
- reconcile status after restart

This is one of the few areas where the first implementation already pointed in the right direction.

### 4. Findings Memory Layer

Responsibilities:

- store current and past findings
- record finding maturity
- keep failed attempts visible
- feed prior findings back into future planning

This should be simpler than a full scientific knowledge graph, but stronger than a flat task list.

### 5. Agent Backend Layer

Responsibilities:

- call whichever model or agent backend is configured
- keep the runtime backend-agnostic
- support local open models as a first-class path

### 6. Artifact Layer

Responsibilities:

- store logs
- store experiment outputs
- store markdown notes
- store generated summaries and reports

The long-term knowledge base can grow from this, but it does not need to begin as a large subsystem.

### 7. Later Hardening Layer

Not part of the initial core, but planned for later:

- approvals
- policy controls
- stronger safety enforcement
- publication workflow controls
- richer review and manuscript subsystems
- web or multi-user management surfaces

## Developer Concept for the Reset

### Development principle

The next attempt should be built around the smallest autonomous loop that can actually teach us something.

That means:

- fewer abstractions
- fewer product surfaces
- fewer governance features
- more emphasis on real runs

### Phase 0: Freeze the old attempt as experience

The current implementation should be treated as:

- a prototype that taught us what not to overbuild

The important deliverable from it is not more code evolution.
It is the experience report now recorded in this document.

### Phase 1: Build the new console-first shell

Build only:

- `clawresearch`
- startup chat
- `/go`
- pause/resume
- readable trace
- current-directory project model

Success criterion:

- a user can start a research session without learning the internal architecture

### Phase 2: Build persistent runs and detached jobs

Build:

- persistent session state
- run records
- job launch
- job monitoring
- restart recovery

Success criterion:

- long-running jobs survive interruption and the research loop can continue afterwards

### Phase 3: Build findings memory

Build:

- idea records
- implemented findings
- validated findings
- failed findings
- simple retrieval of prior findings into the next loop

Success criterion:

- the system does not repeat the same bad directions blindly

### Phase 4: Build repo-aware implementation and debugging

Build:

- code reading
- focused editing
- traceback-aware debugging
- result inspection

Success criterion:

- the system can modify and debug real project code with fewer brittle failures

### Phase 5: Build stronger evaluation and writing support

Build:

- result summaries
- experiment comparison
- literature-grounded notes
- early paper artifact generation

Success criterion:

- outputs become useful research artifacts, not only ephemeral agent traces

### Phase 6: Add hardening after the loop is real

Only after the runtime is clearly useful:

- approval gates
- policy systems
- safety restrictions
- web or platform surfaces

Success criterion:

- hardening improves reliability without obscuring debugging

## Recommended Internal Evaluation for the Reset

At this stage, evaluation should focus on whether the runtime actually functions as a research loop.

Measure at least:

- startup friction
- research-direction quality after the initial chat
- rate of successful long-running job completion
- restart/recovery success
- rate of repeated failed ideas
- usefulness of findings memory
- debugging success on real code
- quality of generated summaries after each run

Human publication scoring is still important later, but it should not be the main gating criterion for the reset core.

## What ClawResearch Should Build First Now

### Highest priority

- console-first entry
- single-directory project model
- persistent runs
- detached job handling
- readable live trace
- minimal findings memory
- restart and recovery
- open model/backend abstraction

### Medium priority

- literature-grounded retrieval improvements
- traceback-aware debugging
- stronger experiment comparison
- markdown knowledge accumulation

### Later priority

- approval gates
- policy and safety layers
- web UI
- publication workflow
- review simulation
- multi-agent specialization

## Main Risks in the Reset

### 1. Rebuilding the old control plane in disguise

We could accidentally recreate the same overbuilt architecture under new names.

### 2. Confusing observability with bureaucracy

We need traces and persistence, but not a maximal control-plane schema from day one.

### 3. Premature hardening

If safety and approval systems return too early, they will again make debugging harder.

### 4. Weak findings memory

If failed and successful findings are not differentiated, the loop will stay wasteful.

### 5. Experiment brittleness

This remains one of the main hard technical problems and should be treated as such.

### 6. Mistaking polished summaries for real research progress

The system must not be judged mainly by how plausible its text looks.

## Practical Positioning for the Reset

The reset version of ClawResearch should be positioned much more narrowly:

> a console-first autonomous research runtime for empirical computational work, built to run long-horizon research loops inside a project directory and accumulate findings, logs, and artifacts over time

It should not initially be positioned as:

- a research management platform
- a governance-heavy orchestration system
- a general-purpose autonomous scientist for all domains

## Final Recommendations After Literature and Implementation Experience

1. Restart the implementation around a smaller console-first core.
2. Treat the current codebase as a prototype archive, not as the foundation to continue extending.
3. Remove the workspace/codebase split from the new primary architecture.
4. Defer approval gates, policy engines, and stronger safety controls until after the autonomous loop is reliable.
5. Keep the insights from the literature that genuinely survive contact with implementation:
   - closed-loop execution
   - findings memory
   - multi-fidelity exploration
   - verifier-centered thinking
   - reproducibility
6. Bias the next attempt toward narrow, well-grounded empirical tasks where feedback is measurable.
7. Optimize first for debuggability, persistence, and learning value, not for platform completeness.

## Revised Target Definition for `clawresearch`

`clawresearch` should now aim to become:

> a console-first, backend-agnostic autonomous research runtime for empirical computational research that starts from a research conversation, works directly in the current project directory, runs long-horizon experiment loops, persists jobs and findings across restarts, and incrementally turns those findings into useful research artifacts.

The initial version should be:

- closed-loop
- observable
- persistent
- findings-memory-driven
- and intentionally minimal in product surface and governance

If built this way, the next ClawResearch attempt will be much more likely to become a usable research system instead of another overgrown prototype.
