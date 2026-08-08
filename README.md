# Forge Loop

Forge Loop is an AI-powered engineering workflow that transforms natural language software tasks into structured, verifiable code changes.

Instead of relying on a single coding agent, Forge Loop orchestrates a deterministic engineering pipeline around interchangeable LLMs.

```
Task
   ↓
Planner
   ↓
Workspace
   ↓
Implementation
   ↓
Validation
   ↓
Review
   ↓
Publish
```

The philosophy behind Forge Loop is:

> **LLMs write code. Forge Loop engineers software.**

---

## Features

- Task-driven engineering workflow
- Isolated Git worktrees
- Pluggable AI coding models
- Deterministic validation
- Independent review stage
- Artifact generation
- Publish pipeline
- Local model support (Ollama)
- OpenAI-compatible providers

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start your local model

Forge Loop currently supports local inference through Ollama.

For example:

```bash
ollama run qwen3.5:9b
```

Make sure Ollama is running before starting a Forge Loop task.

---

## Typical Workflow

A Forge Loop run follows this lifecycle:

```text
Plan
  ↓
Workspace
  ↓
Implement
  ↓
Validate
  ↓
Review
  ↓
Publish
```

### Define the task

```bash
TASK="Add unit regression tests confirming that validateCsvUploadFile accepts valid text/csv uploads named statement.csv, statement.CSV, and statement.CsV. Do not modify production code."
```

Set the repository you want Forge Loop to operate on:

```bash
REPO="/path/to/your/repository"
```

---

## 1. Generate a Plan

Forge Loop first inspects the task and repository and produces a bounded implementation plan.

```bash
npm run dev -- plan \
  --repo "$REPO" \
  --task "$TASK"
```

The planner identifies relevant files, constraints, and the expected implementation approach before any code is modified.

---

## 2. Create an Isolated Workspace

Create a Git worktree for the task:

```bash
npm run dev -- workspace \
  --repo "$REPO" \
  --task "$TASK"
```

Forge Loop creates an isolated workspace so the coding agent never needs to modify the primary working tree directly.

The command returns a workspace path similar to:

```text
generated-worktrees/my-project/20260807T223032Z-62e669a4
```

Store that path:

```bash
WORKSPACE="/path/to/generated-worktree"
```

---

## 3. Implement the Task

Run the implementation agent inside the isolated workspace:

```bash
npm run dev -- implement \
  --workspace "$WORKSPACE" \
  --task "$TASK"
```

The implementation agent:

- inspects relevant code
- follows the task constraints
- edits the repository
- records execution artifacts
- stops when the task is completed or the execution limit is reached

You can inspect the resulting change with:

```bash
git -C "$WORKSPACE" status
```

and:

```bash
git -C "$WORKSPACE" diff
```

---

## 4. Validate the Change

Run Forge Loop's validation stage against the implementation:

```bash
npm run dev -- validate \
  --workspace "$WORKSPACE" \
  --task "$TASK"
```

Validation is deterministic wherever possible and can include:

```text
tests
lint
typecheck
build
scope checks
```

The result is stored as a validation artifact under:

```text
generated-runs/
```

For example:

```bash
VALIDATION_REPORT="generated-runs/<validation-report>.json"
```

---

## 5. Review the Implementation

Run an independent review against the original task and validation evidence:

```bash
npm run dev -- review \
  --workspace "$WORKSPACE" \
  --task "$TASK" \
  --validation-report "$VALIDATION_REPORT"
```

The reviewer checks whether:

- the requested behavior was implemented
- task constraints were preserved
- unrelated code was changed
- validation evidence supports the implementation
- the change is safe to publish

The review output is stored as another run artifact:

```bash
REVIEW_REPORT="generated-runs/<review-report>.json"
```

---

## 6. Publish the Validated Change

Once validation and review have passed, publish the result:

```bash
npm run dev -- publish \
  --workspace "$WORKSPACE" \
  --task "$TASK" \
  --validation-report "$VALIDATION_REPORT" \
  --review-report "$REVIEW_REPORT" \
  --run-id "<run-id>"
```

Publishing prepares the validated workspace for the Git workflow.

Depending on configuration, this can include:

```text
branch creation
commit generation
push
pull request creation
```

---

## Create a Pull Request

If PR creation is configured as a separate command, run:

```bash
npm run dev -- create-pr \
  --workspace "$WORKSPACE" \
  --task "$TASK"
```

Forge Loop can use the original task and generated artifacts to produce the branch and pull request context.

> Note: replace this command with the actual PR command exposed by your Forge Loop CLI if PR creation is handled through `publish` instead.

---

## End-to-End Example

A complete run might look like this:

```bash
REPO="/Users/me/projects/flow-lens-ai"

TASK="Add unit regression tests confirming that validateCsvUploadFile accepts valid text/csv uploads named statement.csv, statement.CSV, and statement.CsV. Do not modify production code."

npm run dev -- plan \
  --repo "$REPO" \
  --task "$TASK"

npm run dev -- workspace \
  --repo "$REPO" \
  --task "$TASK"

WORKSPACE="/Users/me/projects/forge-loop/generated-worktrees/flow-lens-ai/<run-id>"

npm run dev -- implement \
  --workspace "$WORKSPACE" \
  --task "$TASK"

npm run dev -- validate \
  --workspace "$WORKSPACE" \
  --task "$TASK"

VALIDATION_REPORT="generated-runs/<validation-report>.json"

npm run dev -- review \
  --workspace "$WORKSPACE" \
  --task "$TASK" \
  --validation-report "$VALIDATION_REPORT"

REVIEW_REPORT="generated-runs/<review-report>.json"

npm run dev -- publish \
  --workspace "$WORKSPACE" \
  --task "$TASK" \
  --validation-report "$VALIDATION_REPORT" \
  --review-report "$REVIEW_REPORT" \
  --run-id "<run-id>"
```

---

## Inspecting a Run

Each Forge Loop execution leaves artifacts that can be inspected after the run.

```bash
ls generated-runs
```

Typical artifacts include:

```text
plan
implementation trace
validation report
review report
publish report
```

Inspect the actual Git change:

```bash
git -C "$WORKSPACE" diff
```

Inspect commits:

```bash
git -C "$WORKSPACE" log --oneline --decorate -10
```

Inspect the workspace status:

```bash
git -C "$WORKSPACE" status
```

---

## CLI Help

To see available Forge Loop commands:

```bash
npm run dev -- --help
```

For command-specific help:

```bash
npm run dev -- plan --help
npm run dev -- workspace --help
npm run dev -- implement --help
npm run dev -- validate --help
npm run dev -- review --help
npm run dev -- publish --help
```

## Why?

Current coding agents are excellent at writing code but often lack a repeatable engineering process.

Forge Loop wraps coding models inside an opinionated workflow that emphasizes:

- planning
- reproducibility
- validation
- review
- traceability

The model becomes a worker rather than the source of truth.

---

## Workflow

```
Natural Language Task
        │
        ▼
     Planning
        │
        ▼
 Git Worktree Creation
        │
        ▼
Implementation Agent
        │
        ▼
 Automated Validation
        │
        ▼
 Review Agent
        │
        ▼
 Publish
```

---

## Example

```bash
npm run dev -- implement \
  --workspace path/to/repo \
  --task "Add regression tests for CSV uploads"
```

---

## Generated Artifacts

Each execution produces structured outputs such as:

```
generated-runs/

plan.md

implementation.log

validation.json

review.json

publish.log
```

These artifacts make every run inspectable and reproducible.

---

## Models

Forge Loop is model agnostic.

Examples include:

- Ollama
- OpenAI Codex
- GPT
- Claude
- Gemini
- Local models

---

## Design Principles

- AI interprets.
- Deterministic software validates.
- Every change must be reviewable.
- Every execution should leave artifacts.
- Humans remain in control.

---

## Status

Forge Loop is currently an MVP focused on autonomous software engineering workflows.
