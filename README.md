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
