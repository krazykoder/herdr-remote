# System Architecture Explanations

## Separation of Engine vs. Payload (.antigravity vs. .workflow)

This project follows a strict **"Engine vs. Payload"** (or Code vs. Data) separation of concerns. This separation is reflected in the directory structure:

### 1. Separation of Concerns (System vs. State)
- **`.antigravity/` is the System Engine.** It contains the immutable rules, system configurations, instructions, and templates that operate the factory.
- **`.workflow/` is the Active Project State.** It contains the transient, ever-changing artifacts of the software development lifecycle (the raw materials and the outputs like scratchpads, plans, and reports).

### 2. Portability and Reusability
By keeping the agents (prompts, addendum templates, and rules) in `.antigravity/`, the entire system becomes portable. 
- You can copy the entire folder into a new project and hit the ground running.
- In Contrast, if prompts were mixed into `.workflow/`, you would have to untangle the system rules from the project-specific architecture docs, implementation plans, and walkthroughs.

### 3. Protection from Agent Hallucination ("Air-Gapping")
Agents are heavily instructed to read and write to various subdirectories inside `.workflow/` (e.g., the Brainstormer writes to `01_concepts`, the Architect to `02_architecture`). 
If core System Prompts lived inside `.workflow/`, there is a risk that an agent might accidentally overwrite, delete, or hallucinate changes into its own system prompts or another agent's prompt during documentation updates. 
Keeping prompts in `.antigravity/` creates a natural "air-gap." The agents know they are allowed to actively modify `.workflow/`, but `.antigravity/` remains strictly read-only system configuration.
