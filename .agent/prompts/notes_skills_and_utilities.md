Getting AI agents to actually map out the territory before they start building is a common hurdle. By default, models are eager to please and will often jump straight into writing code or drafting plans based on assumptions rather than deeply querying the local context.

To ensure your agents consistently use **ast-grep** (for structural, syntax-aware search) and **Graphify** (for dependency mapping) before generating a plan, you need to establish a strict operational sequence in their system prompts.

Here is how you can explicitly mandate that behavior.

### 1. The "Pre-Flight Checklist" Prompt Directives

You need to add a strict rule block that forces the agent to use these tools as a required prerequisite. You can inject this specific language into your system prompts:

> **CRITICAL WORKFLOW REQUIREMENT: DISCOVERY BEFORE PLANNING**
> Before drafting any architectural plans, specifications, or writing code, you **MUST** map the existing codebase using your installed tools.
> 1. **Dependency Mapping:** You must execute `Graphify` to understand the relationships, imports, and architectural blast radius of the target modules.
> 2. **Structural Search:** You must execute `ast-grep` to identify existing design patterns, interface definitions, and structural logic related to the task. Do not rely solely on standard text-based search.
> 3. **Proof of Discovery:** Your first output must be a brief summary of the architectural context discovered via Graphify and ast-grep. You are strictly forbidden from proposing a plan until this context has been gathered and summarized.
> 
> 

### 2. Distributing Across Your Agent Roles

Since you are managing 5 different system prompts, it is highly effective to tie these tool requirements to specific phases within a spec-driven architectural approach. Not every agent needs to use both tools the exact same way.

* **The Strategist / Architect Roles (Phase 01 - 02):**
These prompts should have the heaviest enforcement of Graphify. Their job is to understand the macro-system.
* *Prompt Addition:* "Use Graphify to identify all downstream dependencies of the proposed feature. Produce a dependency graph summary. Use ast-grep to locate the current base classes or interfaces we will need to extend."


* **The Implementer Role (Phase 03 - 04):**
The Implementer should lean heavily on ast-grep for micro-context while referencing the Architect's broader plan.
* *Prompt Addition:* "Before modifying any file outlined in the specification, use ast-grep to verify the exact signature, variable scoping, and syntax tree of the target functions."


* **The Auditor Role (Phase 05):**
The Auditor can use these tools in reverse to verify the work.
* *Prompt Addition:* "Use ast-grep to verify that the newly implemented code adheres to the project's structural patterns. Use Graphify to ensure no circular dependencies were introduced."



### 3. Tool-Specific Instructions

Sometimes agents have the skills installed but lack the intuition of *how* to use them effectively. Giving them a quick "tool mastery" cheat sheet in the system prompt helps immensely.

**For ast-grep:**

> *Tool Guideline:* When searching the codebase, prefer `ast-grep` over standard grep. Use it to find structural patterns (e.g., finding all instances where a specific React hook is called, or how Arrow data structures are initialized) rather than just keyword matching.

**For Graphify:**

> *Tool Guideline:* Use `Graphify` whenever you are touching shared utilities, modifying a core data pipeline, or rewriting a UI component. You must verify that your planned changes will not break undocumented dependent modules.

### A Quick Debugging Tip

If you add these rules and the agent *still* skips to planning, require a strict formatted output. Tell the agent its response must start with a `# Codebase Discovery` header detailing the exact `ast-grep` and `Graphify` queries it ran. If it tries to write a `# Plan` without that first header, the prompt structure will usually force it to self-correct before it finishes generating the response.

Since you are splitting this across 5 different prompts, are you finding that your implementation agents are ignoring the context gathered by your architecture/planning agents, or is the main bottleneck just getting that initial codebase scan to happen reliably?