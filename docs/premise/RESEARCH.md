# Research evidence and candidate mechanisms

## Scope and standard of evidence

The question is whether midnight.server improves **effective task performance** for a fixed model. External evidence, computation, memory, and search can improve the system's results without changing its weights. None guarantees a general intelligence increase, and published gains on other models/tasks are not direct evidence about Luna or Sol.

This pass downloaded primary paper landing pages/abstracts and current project documentation. Source URLs and content hashes are in [sources.json](sources.json). The paper triage below is **not a full-text systematic review or an independent reproduction of published scores**. No external implementation was copied into production. The submodular selector was implemented from the stated mathematical objective and checked against exhaustive optima on small deterministic fixtures.

## Evidence retrieval and environment feedback

- **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** ([paper](https://arxiv.org/abs/2405.15793)). The interface through which a model views and changes a repository matters. This supports testing structured navigation, edit feedback, and bounded tool outputs. It does not imply that every extra tool helps. Our existing LSP lookup, parse gate, and repair features should be ablated, not duplicated.
- **Agentless: Demystifying LLM-based Software Engineering Agents** ([paper](https://arxiv.org/abs/2407.01489)). A staged localization/repair/validation approach is a useful counterweight to unconstrained agent complexity. A simpler baseline is mandatory when comparing a more elaborate search harness.
- **Lost in the Middle: How Language Models Use Long Contexts** ([paper](https://arxiv.org/abs/2307.03172)). Available context capacity is not equivalent to reliable use of every fact in that context. This motivates measuring actual evidence inclusion and position, not just increasing the token window. Its studied conditions should not be assumed to transfer unchanged to current models.
- **SWE-bench: Can Language Models Resolve Real-World GitHub Issues?** ([paper](https://arxiv.org/abs/2310.06770), [official harness](https://github.com/SWE-bench/SWE-bench), [Lite dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite)). Real issue/base-tree pairs are a better localization test than tiny synthetic projects. The official containerized tests remain necessary for task-resolution scores. File recall is not a substitute for those tests.

## Reflection, verification, and additional compute

- **Large Language Models Cannot Self-Correct Reasoning Yet** ([paper](https://arxiv.org/abs/2310.01798)). The examined intrinsic self-correction settings are a warning against assuming a second self-review improves the first answer. Do not generalize the title into a claim that external feedback never helps. Our design should supply new observations instead of repeating “try harder.”
- **Reflexion: Language Agents with Verbal Reinforcement Learning** ([paper](https://arxiv.org/abs/2303.11366)). Feedback-linked memory is a candidate mechanism. In a product it also needs provenance, expiration, permission boundaries, and tests for harmful transfer. Saving an agent's confident but unverified explanation is not the same as saving a verified lesson.
- **Scaling LLM Test-Time Compute Optimally Can Be More Effective than Scaling Model Parameters** ([paper](https://arxiv.org/abs/2408.03314)). Compute allocation and verification are task/difficulty dependent. This motivates conditional rather than unconditional extra work. Its mathematical-reasoning results do not establish coding gains for the models here.
- **Self-Consistency Improves Chain of Thought Reasoning in Language Models** ([paper](https://arxiv.org/abs/2203.11171)). Multiple samples can help when answers can be aggregated meaningfully. Arbitrary patches do not have a canonical majority answer, and independent samples can share the same misconception. Any portfolio needs a selection rule whose performance is measured without hidden-answer access.

## Search, diversity, and mathematical tools

- **Language Agent Tree Search Unifies Reasoning Acting and Planning in Language Models** ([paper](https://arxiv.org/abs/2310.04406)) and **SWE-Search: Enhancing Software Agents with Monte Carlo Tree Search** ([paper](https://arxiv.org/abs/2410.20285)). Search over alternative actions/patches is plausible when rollouts have useful feedback. Before adding a tree, implement isolated checkpoints, a trustworthy reward, and strict aggregate budgets. Otherwise a larger search can simply optimize a bad visible test more aggressively.
- **Nemhauser, Wolsey, and Fisher: An analysis of approximations for maximizing submodular set functions—I** ([publication](https://doi.org/10.1007/BF01588971)). Diminishing-return objectives admit efficient approximate selection under suitable constraints. We ported one concrete nonnegative relevance-plus-facet-coverage objective, not a generic “intelligence algorithm.” The guarantee is restricted to its surrogate and cardinality constraint. Our real-repository experiment was negative, so the new selector is not activated.
- **Determinantal Point Processes for Machine Learning** ([survey](https://arxiv.org/abs/1207.6083)). Determinant-based selection can favor a diverse set rather than near-duplicates. This is a candidate for diverse hypotheses or contexts, but constructing a similarity kernel that tracks meaningful differences is itself a modeling assumption. We did not implement DPP sampling after the simpler coverage experiment regressed.

Other useful mathematics must have an observable target:

| Method | Appropriate use | Assumption that prevents a blanket claim |
| --- | --- | --- |
| Expected information gain | Choose a diagnostic check that best distinguishes explicit hypotheses | Requires defensible hypotheses and probabilities; invented priors do not become calibrated evidence |
| UCB-style bandit allocation | Allocate trials to candidate procedures with measured rewards | Correlated, nonstationary software tasks violate simple independent-reward assumptions |
| Sequential likelihood-ratio tests | Stop a predeclared comparison early under a valid model | Repeated tuning, task reuse, and optional stopping need explicit correction |
| SMT / constraint solving | Discharge a bounded, faithfully translated obligation | Proving the wrong specification is still wrong; solver success is not whole-program correctness |
| Property/metamorphic testing | Check contract-implied relations across generated inputs | The relation must follow from the user's contract, not from the implementation being graded |
| Mutation testing | Ask whether a verifier detects plausible wrong implementations | Mutation survival diagnoses a weak test; it does not identify the correct patch by itself |
| Paired, clustered inference | Estimate gains on the same held-out tasks across methods | Repeated seeds do not create more independent tasks; tiny samples remain weak evidence |

These are candidates, not additional implemented features. Do not add mathematical machinery before establishing its measurement, cost, and failure mode.

## Skills and MCP

The installed midnight.server documentation supports explicit skills, progressive tool discovery, and MCP server configuration. Read-only tool descriptions are not a sandbox: a tool can still expose private data, and an executable server can run code on its host.

- **Agent Skills specification** ([specification](https://agentskills.io/specification)): narrow, versioned, on-demand procedures are preferable to a permanent omnibus prompt. The new `verified-exploration` example is manually invoked and experimental. Its workflow pilot had no accuracy gain; discovery/trigger behavior was not measured.
- **Context7** ([official project](https://github.com/upstash/context7)): candidate source for version-specific library documentation. Test on tasks where stale API assumptions cause failures. Compare against direct primary-document retrieval and a no-tool control. Document the query data sent externally; do not send private repository contents by default.
- **Playwright MCP** ([official project](https://github.com/microsoft/playwright-mcp)): candidate for observable browser state and UI interactions. Test on held-out UI tasks with independent screenshots/DOM assertions and isolated browser profiles. Its inspected package metadata used alpha Playwright dependencies; that was not treated as sufficient reason to install or bundle it automatically. A browser observation channel and a browser-control permission grant are different things.
- **MCP security best practices** ([specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)): require scoped authority, safe authentication flows, and explicit trust boundaries. Tool-returned instructions and web pages must not override the user's task or authorize data exfiltration.

No MCP server was installed in this pass. The available gateway reported no search tools, so source retrieval used HTTPS with certificate verification. The Python HTTPS path initially failed certificate verification; Windows `curl` succeeded without disabling TLS checks. Downloading documentation is not verification of a server implementation, its dependencies, permissions, or claimed task gains.

## What would count as success?

A fixed-model method must improve independently graded task outcomes or deliver comparable outcomes with lower resource cost. Report the full trade-off, not just the best-looking metric. Model escalation, more samples, longer reasoning budgets, different tool access, and hidden grader feedback are separate interventions.

For creativity, require feasible outputs first, then blinded judgments on usefulness and originality. More unusual text, more proposals, or a model grading its own novelty does not establish better creativity. For software, preference judgments must not replace correctness checks.

The present results reject two immediate rollouts. They do not reject the overall harness premise. The next strongest experiment is **bounded alternative repair selected by independent checks on real repository tasks**, compared against equally budgeted baseline attempts. See the acceptance gate in [README.md](README.md) before spending a larger model budget.
